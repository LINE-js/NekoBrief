import { once } from 'node:events';
import { loadConfig, ConfigError } from './config.js';
import { LineRecorder } from './line.js';
import { ChatLog } from './store.js';
import { Summarizer } from './summarizer.js';
import { createWebServer } from './web.js';

const args = process.argv.slice(2);
let filename = 'config.yaml';
let check = false;
let valid = true;
for (let index = 0; index < args.length; index += 1) {
  const next = args[index + 1];
  if (args[index] === '--check') check = true;
  else if (args[index] === '--config' && next && !next.startsWith('--')) {
    filename = next;
    index += 1;
  } else valid = false;
}

const print = (code: string) => console.log(`[NekoBrief] ${code}`);

if (!valid) {
  console.error('用法：npm start -- [--config 設定檔路徑] [--check]');
  process.exitCode = 1;
} else {
  let log: ChatLog | undefined;
  try {
    const config = await loadConfig(filename);
    if (check) {
      console.log(`本機設定檢查通過；摘要模型 ${config.claude.model}，時區 ${config.timezone}。尚未驗證外部服務。`);
    } else {
      log = new ChatLog(config.database);
      const recorder = new LineRecorder({ config: config.line, log, timezone: config.timezone, print });
      const summarizer = new Summarizer({
        claude: config.claude, log, chats: [...config.line.chats.keys()], timezone: config.timezone, print,
      });
      const server = createWebServer({ chats: config.line.chats, log, timezone: config.timezone });
      server.listen(config.web.port, config.web.host);
      await once(server, 'listening');
      print(`web http://${config.web.host}:${config.web.port}`);
      const shutdown = () => {
        recorder.stop();
        server.close();
        server.closeAllConnections();
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      recorder.start();
      summarizer.start();
      await recorder.closed;
      await summarizer.stop();
      if (server.listening) await once(server, 'close');
    }
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : '啟動失敗；請確認設定、連接埠與資料庫檔案。');
    process.exitCode = 1;
  } finally {
    log?.close();
  }
}
