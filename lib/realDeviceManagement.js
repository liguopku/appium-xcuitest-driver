import { exec } from 'teen_process';


async function getConnectedDevices () {
  //let {stdout} = await exec('idevice_id', ['-l']);
  //return stdout.trim().split('\n');
  //return 'c8973b730db2e24b1884953e3063f5c0ad420946'
  try {
    let {stdout} = await exec('/usr/local/Cellar/libimobiledevice/1.2.0/bin/idevice_id', ['-l']);
    return stdout.trim().split('\n');
  } catch (e) {
    return ['c8973b730db2e24b1884953e3063f5c0ad420946'];
  }

}

export { getConnectedDevices };
