import wd from 'wd';
import { startServer } from '../../..';


const HOST = 'localhost',
      PORT = 4994;

let driver, server;

async function initDriver () {
  driver = wd.promiseChainRemote(HOST, PORT);
  server = await startServer(PORT, HOST);

  return driver;
}

async function initSession (caps) {
  await initDriver();
  await driver.init(caps);

  return driver;
}

async function deleteSession () {
  try {
    await driver.quit();
  } catch (ign) {}
  await server.close();
}

export { initDriver, initSession, deleteSession, HOST, PORT };
