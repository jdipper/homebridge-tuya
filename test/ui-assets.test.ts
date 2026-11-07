import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

// Homebridge/browser caches can retain a previous pilot's assets even after a
// child-bridge restart. Each changed asset must get a different request URL.
test.each(['schedule.js', 'schedule.css'])('the editor cache key identifies the actual %s content', name => {
  const directory = path.join(__dirname, '../homebridge-ui/public');
  const html = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
  const hash = createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex').slice(0, 12);
  expect(html).toContain(`${name}?v=${hash}`);
});

test('unvalidated Hold has no browser activation path while restoration remains available', () => {
  const script = fs.readFileSync(path.join(__dirname, '../homebridge-ui/public/schedule.js'), 'utf8');
  expect(script).toContain('Unavailable pending FastWarm Hold validation.');
  expect(script).not.toContain('/overrides/preview');
  expect(script).not.toContain('/overrides/start');
  expect(script).toContain('/overrides/cancel');
  expect(script).toContain('Retry programme restoration');
});
