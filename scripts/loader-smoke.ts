// Loader smoke test: point SUPERMODEL config dir at repo models/, load, print roles/flows of memory-crawler
import path from 'path';
import fs from 'fs';
import os from 'os';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-home-'));
fs.mkdirSync(path.join(tmpHome, '.supermodel'), { recursive: true });
fs.cpSync(path.join(__dirname, '..', 'models'), path.join(tmpHome, '.supermodel', 'models'), { recursive: true });
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.OPENROUTER_API_KEY = 'test-key';
process.env.APIMART_API_KEY = 'test-key';

(async () => {
  const { ConfigLoader } = await import('../src/config/loader');
  const reg = await ConfigLoader.getInstance().loadConfigs();
  const inst = reg.loadedInstances!.get('memory-crawler')!;
  const crawler = inst.roles.get('crawler')!;
  console.log('crawler.provider_model =', crawler.provider_model);
  console.log('crawler.provider_options =', JSON.stringify(crawler.provider_options));
  const archive = inst.flows.get('archive')!;
  console.log('archive.required_tools =', JSON.stringify((archive.nodes[0] as any).required_tools));
  const recall = reg.loadedInstances!.get('memory-recall')!.roles.get('recall')!;
  console.log('recall.provider_model =', recall.provider_model, JSON.stringify(recall.provider_options));

  // Negative: required_tools not in tools → instance must be rejected
  const badDir = path.join(tmpHome, '.supermodel', 'models', 'memory-crawler', 'flows', 'bad.yaml');
  fs.writeFileSync(badDir, `id: bad\noutput_node: n\nnodes:\n  - id: n\n    type: serial\n    role_id: crawler\n    tools: [list_topics]\n    required_tools: [ingest_message, nonexistent_tool]\n    prompt: x\n`);
  const reg2 = await (ConfigLoader as any).getInstance().loadConfigs();
  console.log('after bad flow, memory-crawler loaded? ', reg2.loadedInstances!.has('memory-crawler'));
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
