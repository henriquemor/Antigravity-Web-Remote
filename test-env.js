import screenshot from 'screenshot-desktop';
import robot from 'robotjs';

async function test() {
  try {
    const screens = await screenshot.listDisplays();
    console.log('--- Displays ---');
    console.log(screens);

    const size = robot.getScreenSize();
    console.log('--- Robot Screen Size ---');
    console.log(size);

    console.log('--- Test Capture ---');
    const img = await screenshot({ format: 'jpg' });
    console.log('Captured image buffer size:', img.length);
    
    process.exit(0);
  } catch (err) {
    console.error('Error during test:', err);
    process.exit(1);
  }
}

test();