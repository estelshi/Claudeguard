import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, stat, rm, symlink, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { validateConfig } from './config.mjs'
import { createController } from './controller.mjs'
import { PORTABLE_DEFAULTS, portableConfig, nodeCatalogue, saveSetup, saveRelay, detectUpstreamChain, discover, refreshGeneratedScript } from './setup.mjs'
import { validateShareConfig } from './config.mjs'
import { prepareSelectedProfile, applyClaudeGuard, composeProfileScript } from './profile.mjs'
import { verifyPolicy, createGuard } from './guard.mjs'
import { validateProbeChain } from './probe.mjs'
const input = { expectedIP: '198.51.100.9', selectedProxy: 'My Japan node' }
const c = portableConfig(input, 'a'.repeat(64))
test('new portable routes report missing integration instead of probing an absent listener',async()=>{
 const controller={request:async path=>path==='/configs'?{mode:'rule'}:path==='/proxies'?{proxies:{}}:{rules:[]}}
 const gateway={status:()=>({open:false}),closeAll:()=>{}}
 const guard=createGuard(c,controller,gateway,async()=>assert.fail('An uninstalled listener must not be probed'))
 const status=await guard.inspect()
 assert.equal(status.enabled,false);assert.equal(status.state,'observe');assert.equal(status.reason,'guard-route-not-installed');assert.equal(status.phase,'awaiting-rules')
})
test('portable IP, loopback endpoints, ports and chain are validated without the owner IP', () => {
 assert.equal(c.expectedIP, input.expectedIP)
 for (const controllerURL of ['http://example.com:9090', 'https://127.0.0.1:9090', 'http://127.0.0.1:9090/path', 'http://user:pass@localhost:9090', 'http://127.0.0.1', 'http://localhost:9090?x=1'])
  assert.throws(() => validateConfig({ controllerURL }))
 assert.throws(() => validateConfig({ controllerSecret: 'bad\r\nsecret' }))
 assert.throws(() => portableConfig({ ...input, upstreamChain: ['DIRECT'] }, 'a'.repeat(64)))
 assert.throws(() => portableConfig({ ...input, clientPort: PORTABLE_DEFAULTS.probePort }, 'a'.repeat(64)))
})
test('catalogue only returns concrete node metadata and omits private fields and changing groups', () => {
 const nodes = nodeCatalogue({ proxies: { DIRECT: { type:'Direct' }, group:{ type:'Selector', all:['node'] }, node:{ type:'Socks5', server:'private', password:'secret', udp:true } } })
 assert.deepEqual(nodes,[{name:'node',type:'Socks5',udp:true,upstreamChain:[]}])
})
test('fixed upstream chains are inferred recursively, without credentials or variable groups', () => {
 const snapshot={proxies:{exit:{type:'Socks5','dialer-proxy':'entry',password:'private'},entry:{type:'Hysteria2','dialer-proxy':'first'},first:{type:'Socks5'}}}
 assert.deepEqual(detectUpstreamChain(snapshot,'exit'),['entry','first'])
 assert.deepEqual(nodeCatalogue(snapshot).find(n=>n.name==='exit').upstreamChain,['entry','first'])
 assert.ok(!JSON.stringify(nodeCatalogue(snapshot)).includes('private'))
 snapshot.proxies.entry={'type':'Selector',all:['first'],now:'first'}
 assert.deepEqual(detectUpstreamChain(snapshot,'exit'),['first'])
 assert.deepEqual(nodeCatalogue(snapshot).find(n=>n.name==='exit').upstreamBindings,{entry:'first'})
 snapshot.proxies.entry={type:'URLTest',all:['first'],now:'first'}
 assert.throws(()=>detectUpstreamChain(snapshot,'exit'))
 assert.ok(nodeCatalogue(snapshot).find(n=>n.name==='exit').chainError)
 snapshot.proxies.entry={type:'Socks5','dialer-proxy':'exit'}
 assert.throws(()=>detectUpstreamChain(snapshot,'exit'))
 delete snapshot.proxies.entry
 assert.throws(()=>detectUpstreamChain(snapshot,'exit'))
 assert.deepEqual(nodeCatalogue({proxies:{'Claude-guard-gateway':{type:'Http'},'GuardNook-Gateway':{type:'Http'}}}),[])
})
test('discovery tries only known local controllers and does not change routes',async()=>{
 const attempts=[]
 const result=await discover({},async input=>{
  attempts.push([input.controllerSocket,input.controllerURL])
  if(!input.controllerURL)throw new Error('No socket')
  return {nodes:[],version:'test'}
 })
 assert.deepEqual(attempts,[[PORTABLE_DEFAULTS.controllerSocket,''],['','http://127.0.0.1:9090']])
 assert.equal(result.controllerURL,'http://127.0.0.1:9090')
 await assert.rejects(discover({},async()=>{throw new Error('unreachable')}))
})
test('save rechecks and persists detected upstreams and refuses unsafe chains before writing',async()=>{
 const root=await mkdtemp(join(tmpdir(),'guardnook-chain-save-'))
 try{
  await saveSetup(root,input,async()=>({nodes:[{name:input.selectedProxy,upstreamChain:['entry']}]}))
  const before=await readFile(join(root,'config.json'),'utf8')
  assert.deepEqual(JSON.parse(before).upstreamChain,['entry'])
  await assert.rejects(saveSetup(root,input,async()=>({nodes:[{name:input.selectedProxy,chainError:'unsafe'}]})))
  assert.equal(await readFile(join(root,'config.json'),'utf8'),before)
 }finally{await rm(root,{recursive:true,force:true})}
})
test('share configuration never reads or takes over a personal or legacy service',async()=>{
 const {mkdir,writeFile}=await import('node:fs/promises')
 const root=await mkdtemp(join(tmpdir(),'guardnook-existing-'))
 const share=join(root,'GuardNook Share')
 const personal=join(root,'ClaudeGuard/config.json')
 try{
  await mkdir(join(root,'ClaudeGuard'));await writeFile(personal,'unchanged private configuration')
  const catalogue={nodes:[{name:input.selectedProxy}]}
  await assert.rejects(saveSetup(share,input,async()=>({...catalogue,personalRoutePresent:true})),{code:'personal-guard-conflict',message:/个人版/})
  await assert.rejects(stat(share),{code:'ENOENT'})
  const saved=await saveSetup(share,input,async()=>catalogue)
  assert.ok(saved.scriptPath)
  const installed=JSON.parse(await readFile(join(share,'config.json'),'utf8'))
  assert.equal(installed.policyGroup,'GuardNookShare-Claude')
  assert.equal(installed.serviceMode,undefined)
  assert.equal(installed.serverPort,19791)
  assert.equal(await readFile(personal,'utf8'),'unchanged private configuration')
  assert.throws(()=>portableConfig({...input,serverPort:18791},''),/reserved/)
  const profile={proxies:[{name:input.selectedProxy,type:'socks5'}],'proxy-groups':[{name:'GuardNook-Claude',type:'select',proxies:['REJECT']}]}
  assert.throws(()=>prepareSelectedProfile(profile,installed),/separate Clash profile/)
  assert.throws(()=>verifyPolicy({configs:{mode:'rule'},proxies:{proxies:{'GuardNook-Gateway':{type:'Http'}}},rules:{rules:[]}},installed),/personal-guard-conflict/)
 }finally{await rm(root,{recursive:true,force:true})}
})
test('authenticated loopback controller works; errors do not disclose credentials', async () => {
 const secret='local-test-secret'
 const server=http.createServer((req,res)=>{assert.equal(req.headers.authorization,`Bearer ${secret}`); res.end(JSON.stringify({version:'test'}))})
 server.listen(0,'127.0.0.1'); await once(server,'listening')
 try { const client=createController(validateConfig({ controllerURL:`http://127.0.0.1:${server.address().port}`,controllerSecret:secret })); assert.deepEqual(await client.request('/version'),{version:'test'}) }
 finally { await new Promise(resolve=>server.close(resolve)) }
})
function original() {return {mode:'rule',proxies:[{name:c.selectedProxy,type:'socks5',udp:true}], 'proxy-groups':[{name:'Ordinary',type:'select',proxies:['DIRECT']}],rules:['MATCH,Ordinary'],dns:{nameserver:['1.1.1.1']},tun:{enable:true}}}
test('selected node profile preserves ordinary traffic, DNS, TUN and original credentials, with no alternate exit', () => {
 const value=original(),before=structuredClone(value)
 const prepared=applyClaudeGuard(prepareSelectedProfile(value,c),c)
 assert.deepEqual(value,before)
 assert.deepEqual(prepared.proxies[0],before.proxies[0])
 assert.deepEqual(prepared.dns,before.dns);assert.deepEqual(prepared.tun,before.tun)
 assert.deepEqual(prepared['proxy-groups'].find(g=>g.name===c.pinnedProxy).proxies,[c.selectedProxy])
 assert.equal(prepared['proxy-groups'].find(g=>g.name===c.pinnedProxy)['disable-udp'],true)
 assert.deepEqual(prepared['proxy-groups'].find(g=>g.name===c.policyGroup).proxies,['REJECT',c.gatewayProxy])
 assert.throws(()=>prepareSelectedProfile(prepared,c))
 const context=vm.createContext({input:value})
 vm.runInContext(composeProfileScript('function main(c){ c.marker = 1; return c; }',c),context)
 assert.equal(vm.runInContext('main(input)',context).marker,1)
})
test('provider node references are supported; proxy groups and reserved names cannot become an upstream', () => {
 const value=original();value.proxies=[];value['proxy-providers']={subscription:{type:'http',url:'https://example.com/private'}}
 const pinned=prepareSelectedProfile(value,c)['proxy-groups'].at(-2)
 assert.deepEqual(pinned.use,['subscription']);assert.equal(pinned.filter,'^My Japan node$');assert.equal(pinned['empty-fallback'],'REJECT')
 assert.doesNotThrow(()=>applyClaudeGuard(prepareSelectedProfile(value,c),c))
 assert.throws(()=>prepareSelectedProfile({...original(),'proxy-groups':[{name:c.selectedProxy,type:'select',proxies:['DIRECT']}]},c))
 assert.throws(()=>portableConfig({...input,selectedProxy:'DIRECT'},'a'.repeat(64)))
})
test('fixed selector edits and unexpected dialer hops fail verification for configured users', () => {
 const snapshot={configs:{mode:'rule'},proxies:{proxies:{[c.policyGroup]:{type:'Selector',all:['REJECT',c.gatewayProxy],now:'REJECT'},[c.gatewayProxy]:{type:'Http',udp:false},[c.pinnedProxy]:{type:'Selector',all:[c.selectedProxy],now:c.selectedProxy,udp:false}}},rules:{rules:['claude.ai','claude.com','anthropic.com','claudeusercontent.com'].map(payload=>({type:'DomainSuffix',payload,proxy:c.policyGroup})).concat(['accounts.google.com','google.com','www.google.com'].map(payload=>({type:'Domain',payload,proxy:c.policyGroup})))}}
 assert.equal(verifyPolicy(snapshot,c),true)
 snapshot.proxies.proxies[c.pinnedProxy].all.push('other');assert.throws(()=>verifyPolicy(snapshot,c))
 const conn={connections:[{metadata:{host:'claude.ai',sourcePort:40000,inboundPort:c.probePort},chains:[c.selectedProxy,c.pinnedProxy]}]}
 assert.deepEqual(validateProbeChain(conn,c,40000,c.probePort),conn.connections[0].chains)
 conn.connections[0].chains.unshift('unexpected');assert.throws(()=>validateProbeChain(conn,c,40000,c.probePort))
})
test('saving is private, preserves the original script and does not silently choose a removed node', async () => {
 const root=await mkdtemp(join(tmpdir(),'guardnook-setup-'))
 try {
  const saved=await saveSetup(root,{...input,originalScript:'function main(c){c.marker=1;return c}'},async()=>({nodes:[{name:c.selectedProxy}]}))
  const config=JSON.parse(await readFile(join(root,'config.json'),'utf8'))
  assert.equal(config.expectedIP,input.expectedIP);assert.match(config.proxyPassword,/^[a-f0-9]{64}$/)
  assert.equal((await stat(join(root,'config.json'))).mode & 0o777,0o600)
  assert.equal((await stat(saved.scriptPath)).mode & 0o777,0o600)
  assert.match(await readFile(saved.scriptPath,'utf8'),/c.marker=1/)
  assert.throws(()=>composeProfileScript(awaitDummy(),c))
  const before=await readFile(join(root,'config.json'),'utf8')
  await assert.rejects(saveSetup(root,input,async()=>({nodes:[]})))
  assert.equal(await readFile(join(root,'config.json'),'utf8'),before)
  await saveSetup(root,input,async()=>({nodes:[{name:c.selectedProxy}]}))
  assert.equal(JSON.parse(await readFile(join(root,'config.json'),'utf8')).proxyPassword,config.proxyPassword)
 } finally {await rm(root,{recursive:true,force:true})}
})
function awaitDummy(){return '// __previousClaudeMain\nfunction main(c){return c}'}
test('private config destination rejects a symlink and leaves its target untouched', async () => {
 const root=await mkdtemp(join(tmpdir(),'guardnook-setup-link-'))
 try {await symlink(join(root,'target'),join(root,'config.json')); await assert.rejects(saveSetup(root,input,async()=>({nodes:[{name:c.selectedProxy}]})))}
 finally{await rm(root,{recursive:true,force:true})}
})
test('CLI entry works from a symlinked application path and returns only safe node metadata', async () => {
 const {spawn}=await import('node:child_process')
 const {fileURLToPath}=await import('node:url')
 const root=await mkdtemp(join(tmpdir(),'guardnook-entry-test-'))
 const server=http.createServer((req,res)=>res.end(JSON.stringify(req.url==='/version'?{version:'test'}:{proxies:{node:{type:'Socks5',password:'must-not-appear'},'GuardNook-Gateway':{type:'Http'}}})))
 server.listen(0,'127.0.0.1');await once(server,'listening')
 try {
  const alias=join(root,'AliasedService');await symlink(fileURLToPath(new URL('.',import.meta.url)),alias)
  const child=spawn(process.execPath,[join(alias,'setup.mjs')],{stdio:['pipe','pipe','pipe']})
  let output='';child.stdout.on('data',chunk=>{output+=chunk})
  const finished=once(child,'close')
  child.stdin.end(JSON.stringify({operation:'catalogue',controllerURL:`http://127.0.0.1:${server.address().port}`}))
  const [code]=await finished;assert.equal(code,0)
  const result=JSON.parse(output);assert.deepEqual(result.nodes,[{name:'node',type:'Socks5',udp:false,upstreamChain:[]}]);assert.equal(result.personalRoutePresent,true);assert.ok(!output.includes('must-not-appear'))
 } finally {await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true})}
})
test('the bundled service entry runs through an alias, stays observational, and exits after its parent quits', async () => {
 const {spawn}=await import('node:child_process')
 const {fileURLToPath}=await import('node:url')
 const net=await import('node:net')
 const free=async()=>{const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port}
 const root=await mkdtemp(join(tmpdir(),'guardnook-parent-test-'))
 const ports=await Promise.all(Array.from({length:5},free))
 const cfg=portableConfig({...input,controllerURL:`http://127.0.0.1:${ports[0]}`,serverPort:ports[1],clientPort:ports[2],probePort:ports[3],gatewayPort:ports[4]},'a'.repeat(64))
 const {writeFile}=await import('node:fs/promises')
 const parent=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})
 let child
 try {
  await symlink(fileURLToPath(new URL('.',import.meta.url)),join(root,'Alias'))
  await writeFile(join(root,'config.json'),JSON.stringify(cfg));await writeFile(join(root,'index.html'),'service test')
  child=spawn(process.execPath,[join(root,'Alias/main.mjs'),'--config',join(root,'config.json'),'--static',root,'--parent-pid',String(parent.pid)],{stdio:'ignore'})
  const closed=once(child,'close')
  let state
  for(let i=0;i<30;i++){try{state=await (await fetch(`http://127.0.0.1:${cfg.serverPort}/api/claude-guard/status`)).json();break}catch{}await new Promise(r=>setTimeout(r,100))}
  assert.equal(state?.expectedIP,input.expectedIP);assert.equal(state?.enabled,false);assert.equal(state?.gateway.open,false)
  const parentClosed=once(parent,'close');parent.kill();await parentClosed
  const timeout=new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Orphaned service did not stop')),5000);timer.unref()})
  const [code]=await Promise.race([closed,timeout]);assert.equal(code,0)
 } finally {if(parent.exitCode===null)parent.kill();if(child?.exitCode===null)child.kill();await rm(root,{recursive:true,force:true})}
})

async function relayFixture(script) {
  const home = await mkdtemp(join(tmpdir(), 'guardnook-refresh-'))
  const root = join(home, 'GuardNook Share')
  const folder = join(root, 'Profiles', '2026-01-01T00-00-00-000Z-00000001')
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const scriptPath = join(folder, 'GuardNook-Clash.js'), originalPath = join(folder, 'original.js')
  await writeFile(originalPath, 'function main(config) { return config; }', { mode: 0o600 })
  await writeFile(scriptPath, script, { mode: 0o600 })
  const config = validateShareConfig({ ...portableConfig({ expectedIP: '198.51.100.9', selectedProxy: 'GN-Exit',
    upstreamChain: [], guardGoogleAuth: false, startProtected: false }, 'a'.repeat(64)), coverageVersion: 1,
  relay: { id: 'a'.repeat(32), host: '198.51.100.10', port: 1080, checkPort: 24958, auth: true, confirmed: true, keyword: '', nodes: ['入口 A'] } })
  await writeFile(join(root, 'config.json'), JSON.stringify(config), { mode: 0o600 })
  await writeFile(join(root, 'SETUP.json'), JSON.stringify({ version: 1, scriptPath, originalPath }), { mode: 0o600 })
  return { home, root, scriptPath }
}
test('verge apply rewrites a stale relay script from the preserved original', async () => {
  const fixture = await relayFixture('// old groups\nconst stale = "GN-Entry"\n')
  try {
    const text = await refreshGeneratedScript(fixture.root, { username: 'u', password: 'p' })
    for (const marker of ['入口选择', '出口选择', 'GN-Exit', 'GuardNookShare-Claude']) assert.ok(text.includes(marker))
    assert.ok(!text.includes('GN-Entry'))
    assert.equal(await readFile(fixture.scriptPath, 'utf8'), text)
    assert.equal((await stat(fixture.scriptPath)).mode & 0o777, 0o600)
  } finally { await rm(fixture.home, { recursive: true, force: true }) }
})
test('verge apply keeps a script that already carries the current relay groups', async () => {
  const fixture = await relayFixture('')
  try {
    const first = await refreshGeneratedScript(fixture.root, { username: 'u', password: 'p' })
    const second = await refreshGeneratedScript(fixture.root, undefined)
    assert.equal(second, first)
    assert.equal(await readFile(fixture.scriptPath, 'utf8'), first)
  } finally { await rm(fixture.home, { recursive: true, force: true }) }
})
test('verge apply rewrites a script whose embedded relay drifted from config', async () => {
  const fixture = await relayFixture('')
  try {
    const first = await refreshGeneratedScript(fixture.root, { username: 'u', password: 'p' })
    const drifted = first.replace(`"id":"${'a'.repeat(32)}"`, `"id":"${'c'.repeat(32)}"`)
    assert.notEqual(drifted, first)
    await writeFile(fixture.scriptPath, drifted, { mode: 0o600 })
    const text = await refreshGeneratedScript(fixture.root, { username: 'u', password: 'p' })
    assert.ok(text.includes(`"id":"${'a'.repeat(32)}"`))
    assert.ok(!text.includes('c'.repeat(32)))
    assert.equal(await readFile(fixture.scriptPath, 'utf8'), text)
  } finally { await rm(fixture.home, { recursive: true, force: true }) }
})
test('verge apply refuses to rewrite an auth relay without credentials', async () => {
  const fixture = await relayFixture('stale script')
  try {
    await assert.rejects(refreshGeneratedScript(fixture.root, undefined), /SOCKS5 凭据不可用/)
    assert.equal(await readFile(fixture.scriptPath, 'utf8'), 'stale script')
  } finally { await rm(fixture.home, { recursive: true, force: true }) }
})
test('verge apply refuses a manifest that points outside the generation folder', async () => {
  const fixture = await relayFixture('stale script')
  try {
    const outside = join(fixture.home, 'original.js')
    await writeFile(outside, 'function main(config) { return config; }')
    await writeFile(join(fixture.root, 'SETUP.json'), JSON.stringify({ version: 1, scriptPath: fixture.scriptPath, originalPath: outside }))
    await assert.rejects(refreshGeneratedScript(fixture.root, { username: 'u', password: 'p' }), /原始脚本的位置异常/)
    assert.equal(await readFile(fixture.scriptPath, 'utf8'), 'stale script')
  } finally { await rm(fixture.home, { recursive: true, force: true }) }
})
test('re-saving the same relay keeps the verified exit and probe port', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guardnook-relay-resave-'))
  const id = 'b'.repeat(32)
  const nodes = [{ name: '入口 A', type: 'Hysteria2', udp: true, upstreamChain: [] }]
  const save = extra => saveRelay(root, { confirmChanges: true, relayID: id,
    exit: { host: '198.51.100.10', port: 1080, username: 'u', password: 'p' },
    entry: { nodes: ['入口 A'] }, originalScript: 'function main(c){return c}', ...extra },
    async () => ({ nodes, personalRoutePresent: false }))
  try {
    await save()
    const first = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
    await writeFile(join(root, 'config.json'), JSON.stringify({ ...first, relay: { ...first.relay, confirmed: true } }), { mode: 0o600 })
    await save()
    const second = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
    assert.equal(second.relay.id, id)
    assert.equal(second.relay.checkPort, first.relay.checkPort)
    assert.equal(second.relay.confirmed, true)
    assert.equal(second.relay.auth, true)
    await save({ exit: { host: '198.51.100.11', port: 1080, username: 'u', password: 'p' } })
    const third = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
    assert.equal(third.relay.host, '198.51.100.11')
    assert.equal(third.relay.confirmed, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
