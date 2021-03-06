import _ from 'lodash';
import path from 'path';
import url from 'url';
import B from 'bluebird';
import { SubProcess, exec } from 'teen_process';
import { JWProxy } from 'appium-base-driver';
import { fs } from 'appium-support';
import log from './logger';
import { getLogger } from 'appium-logger';
import { systemLogExists } from './simulatorManagement.js';


const agentLog = getLogger('WebDriverAgent');

const AGENT_PATH = path.resolve(__dirname, '..', '..', 'WebDriverAgent', 'WebDriverAgent.xcodeproj');
const BOOTSTRAP_PATH = path.resolve(__dirname, '..', '..', 'WebDriverAgent');
const AGENT_LOG_PREFIX = 'XCTStubApps[';
const AGENT_RUNNER_LOG_PREFIX = 'XCTRunner[';
const SIM_BRIDGE_LOG_PREFIX = 'CoreSimulatorBridge[';
const AGENT_STARTED_REGEX = /ServerURLHere->(.*)<-ServerURLHere/;
const LOG_STARTTIME_REGEX = /Built at (\w{3} \d{2} \d{4} \d{2}:\d{2}:\d{2})/;
const DEVICE_CONSOLE_PATH = '/Users/guo.li/Documents/GitHub/deviceconsole/deviceconsole/deviceconsole';

class WebDriverAgent {

  // agentPath (optional): Path to WebdriverAgent Executable (inside WebDriverAgent.app)
  constructor (args = {}) {
    if (args.agentPath) {
      log.info(`Custom agent path specified: ${args.agentPath}`);
    } else {
      log.info(`Using default agent: ${AGENT_PATH}`);
    }

    if (args.bootstrapPath) {
      log.info(`Custom bootstrap path specified: ${args.bootstrapPath}`);
    } else {
      log.info(`Using default bootstrap: ${BOOTSTRAP_PATH}`);
    }

    this.device = args.device;
    this.platformVersion = args.platformVersion;
    this.host = args.host;
    this.realDevice = !!args.realDevice;

    this.agentPath = args.agentPath || AGENT_PATH;
    this.bootstrapPath = args.bootstrapPath || BOOTSTRAP_PATH;
    this.realDeviceLogger = args.realDeviceLogger || DEVICE_CONSOLE_PATH;
    this.wdaLocalPort = args.wdaLocalPort;
  }

  async launch (sessionId) {
    log.info('Launching WebDriverAgent on the device');

    if (!await fs.exists(this.agentPath)) {
      throw new Error(`Trying to use WebDriverAgent project at '${this.agentPath}' but the ` +
                      'file does not exist');
    }

    // make sure that the WDA library has been built
    await this.checkForDependencies();

    // start the logging process
    this.deviceLogs = this.realDevice ? this.createRealDeviceLogsSubProcess()
                                      : this.deviceLogs = this.createSimLogsSubProcess();

    this.xcodebuild = await this.createXcodeBuildSubProcess();

    // start the xcodebuild process
    let agentUrl = await this.startXcodebuild();

    this.url = url.parse(agentUrl);
    
    if (this.realDevice) {
      let localport = this.wdaLocalPort || this.url.port;
      this.iproxy = this.createiProxySubProcess(localport, this.url.port);
      //await this.startiproxy();
      this.iproxy.start();
      this.url.hostname = `localhost`;
    }

    this.setupProxy(sessionId);

    return agentUrl;
  }

  setupProxy (sessionId) {
    
    this.jwproxy = new JWProxy({server: this.url.hostname, port: this.url.port, base: ''});
    log.debug("sessionId is " + sessionId);
    this.jwproxy.sessionId = sessionId;
    log.debug("setupProxy with " + this.jwproxy.sessionId);
    this.proxyReqRes = this.jwproxy.proxyReqRes.bind(this.jwproxy);
  }

  async checkForDependencies () {
    if (!await fs.hasAccess(`${this.bootstrapPath}/Carthage`)) {
      log.debug('Running WebDriverAgent bootstrap script to install dependencies');
      await exec('/bin/bash', ['Scripts/bootstrap.sh', '-d'], {cwd: this.bootstrapPath});
    }
    if (!await fs.hasAccess(`${this.bootstrapPath}/Resources`)) {
      log.debug('Creating WebDriverAgent resources directory');
      await fs.mkdir(`${this.bootstrapPath}/Resources`);
    }
    if (!await fs.hasAccess(`${this.bootstrapPath}/Resources/WebDriverAgent.bundle`)) {
      log.debug('Creating WebDriverAgent resource bundle directory');
      await fs.mkdir(`${this.bootstrapPath}/Resources/WebDriverAgent.bundle`);
    }
  }

  async createXcodeBuildSubProcess () {
    let args = [
      '-project', this.agentPath,
      '-scheme', 'WebDriverAgentRunner',
      '-destination', `id=${this.device.udid}`,
      'test',
    ];
    // TODO: Passing CODE_SIGN_IDENTITY doesnt help. Need to pass team id to xcodebuild but how?
    //Meanwhile we need to document changes that user needs to make it to WDA xcodeproject.
    /*if (this.realDevice) {
      args.push('CODE_SIGN_IDENTITY="iPhone Developer"');
      args.push('CODE_SIGNING_REQUIRED=YES');
    }*/
    let xcodebuild = new SubProcess('xcodebuild', args, {cwd: this.bootstrapPath});

    xcodebuild.on('output', (stdout, stderr) => {
      let out = stdout || stderr;
      // we want to pull out the log file that is created, and highlight it
      // for diagnostic purposes
      if (out.indexOf('Writing diagnostic log for test session to') !== -1) {
        // pull out the first line that begins with the path separator
        // which *should* be the line indicating the log file generated
        let logLocation = _.first(_.remove(out.trim().split('\n'), (v) => v.indexOf(path.sep) === 0));
        log.debug(`Log file for xcodebuild test: ${logLocation}`);
      }
      // log output of xcodebuild, for debugging
      // log.info(out);
    });

    return xcodebuild;
  }

  createSimLogsSubProcess () {
    let args = [
      '-f',
      '-n', '0',
      path.resolve(this.device.getLogDir(), 'system.log')
    ];

    let logs = new SubProcess('tail', args);
    this.setupLogging(logs, 'Sim');
    return logs;
  }

  createiProxySubProcess (localport, deviceport) {
    log.debug(`Starting iproxy to forward traffic from local port ${localport} to device port ${deviceport} over USB`);
    
    return new SubProcess(`iproxy`, [localport, deviceport, this.device.udid]);
  }

  createRealDeviceLogsSubProcess () {
    let logs = new SubProcess(`${this.realDeviceLogger}`, ['-u', this.device.udid]);
    this.setupLogging(logs, 'Device');
    return logs;
  }

  setupLogging (logs, prefix) {
    let loggingStarted = !this.realDevice;
    let startTime = new Date();
    function shouldStartLogging (row) {
      let logRowParts = row.split(/\s+/);
      let logRowDate = new Date(`${startTime.getFullYear()} ${logRowParts[0]} ${logRowParts[1]} ${logRowParts[2]}`);
      loggingStarted = logRowDate.isAfter(startTime);
      return loggingStarted;
    }

    function isPertinentLogLine (line) {
      return line.length &&
            (line.indexOf(AGENT_LOG_PREFIX) !== -1 ||
             line.indexOf(AGENT_RUNNER_LOG_PREFIX) !== -1 ||
             line.indexOf(SIM_BRIDGE_LOG_PREFIX) !== -1);
    }

    logs.on('output', (stdout, stderr) => {
      let out = stdout || stderr;
      // make sure we are not reading logs from before this test run
      if (!loggingStarted && !shouldStartLogging(out)) {
        return;
      }
      if (isPertinentLogLine(out)) {
        agentLog.debug(`${prefix}: ${out.trim()}`);
      }
    });
  }

  async startXcodebuild () {
    // wrap the start procedure in a promise so that we can catch, and report,
    // any startup errors that are thrown as events
    return await new B(async (resolve, reject) => {
      this.xcodebuild.on('exit', (code, signal) => {
        log.info(`xcodebuild exited with code '${code}' and signal '${signal}'`);
        if (!signal && code !== 0) {
          return reject(new Error(`xcodebuild failed with code ${code}`));
        }
      });

      this.deviceLogs.on('exit', (code) => {
        let msg = `${this.realDevice ? 'System' : 'Simulator'} log exited with code '${code}'`;
        log.info(msg);
        if (code) {
          return reject(msg);
        }
      });

      let startTime = new Date();
      await this.xcodebuild.start();
      let agentUrl = await this.waitForStart(startTime);

      resolve(agentUrl);
    });
  }

  async waitForStart (startTime) {
    // we have to wait for the sim to start before we can tail the log file
    if (!this.realDevice) {
      await systemLogExists(this.device);
    }

    let agentUrl;
    let lineCount = 0;
    let reachedEnd = !this.realDevice; // simulator does not need to wait, since we are tailing

    let startDetector = (stdout) => {
      // on a real device there may already be system logs that need to be
      // passed before we get to the real startup logs, otherwise
      // we expect two lines, one after another
      //     Jul 20 13:03:57 iamPhone XCTRunner[296] <Warning>: Built at Jul 20 2016 13:03:50
      //     Jul 20 13:03:57 iamPhone XCTRunner[296] <Warning>: ServerURLHere->http://10.35.4.122:8100<-ServerURLHere
      if (!reachedEnd) {
        let dateMatch = LOG_STARTTIME_REGEX.exec(stdout);
        //log.info(`dateMatch is ${dateMatchq}`);

        if (dateMatch) {
          let buildTime = new Date(dateMatch[1]);
          if (buildTime.isAfter(startTime)) {
            reachedEnd = true;
          }
        }
      }

      if (reachedEnd) {
        let match = AGENT_STARTED_REGEX.exec(stdout);
        if (match) {
          agentUrl = match[1];
          log.info(`Detected that WebDriverAgent is running at url '${agentUrl}'`);
          if (!agentUrl) {
            log.errorAndThrow(new Error('No url detected from WebDriverAgent'));
          }
          // check for (null) url (e.g., 'http://(null):8100'), which happens on real devices
          if (/(\(null\))/.test(agentUrl)) {
            let msg = `Unable to detect url from WebDriverAgent: ${agentUrl}. ` +
                      'Is the device on the same network as the server?';
            //log.errorAndThrow(new Error(msg));
            log.debug(new Error(msg));

          }

          return true;
        }
      }

      // periodically log, so it does not look like everything died
      lineCount++;
      if (lineCount % 100 === 0) {
        log.debug('Waiting for WebDriverAgent server to finish loading...');
      }

      return false;
    };

    log.info('Waiting for WebDriverAgent to start on device');
    await this.deviceLogs.start(startDetector);
   // await this.deviceLogs.start(5000);

    //agentUrl="http://192.168.0.3:8100";
    log.info(`WebDriverAgent started at url '${agentUrl}'`);

    return agentUrl;
  }

  async startiproxy () {
    log.debug("start iproxy");
    return await new B(async (resolve, reject) => {
      this.iproxy.on('exit', (code) => {
        if (code) {
          return reject(new Error(`iproxy  exited with code '${code}'`));
        }
      });

      //await this.iproxy.start(2000);
      await this.iproxy.start();
      resolve();
     // log.debug("start iproxy proc '${this.iproxy.proc}'");
    });
  }

  async quit () {
    log.info('Shutting down WebDriverAgent');
    let getStopPromises = (signal) => {
      let stops = [];
      if (this.xcodebuild && this.xcodebuild.proc) {
        stops.push(this.xcodebuild.stop(signal));
      }
      if (this.deviceLogs && this.deviceLogs.proc) {
        stops.push(this.deviceLogs.stop(signal));
      }
      if (this.iproxy && this.iproxy.proc) {
        stops.push(this.iproxy.stop(signal));
      }
      return stops;
    };

    if (this.jwproxy) {
      this.jwproxy.sessionId = null;
    }

    try {
      await B.all(getStopPromises());
    } catch (err) {
      if (err.message.indexOf('Process didn\'t end after') === -1) {
        throw err;
      }
      log.debug('WebDriverAgent process did not end in a timely fashion. ' +
                'Sending SIGHUP signal...');
      await B.all(getStopPromises('SIGHUP'));
    }
  }
}

export default WebDriverAgent;
