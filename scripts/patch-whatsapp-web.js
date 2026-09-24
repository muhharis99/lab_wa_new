const fs = require('fs');
const path = require('path');

const target = path.join(
  process.cwd(),
  'node_modules',
  'whatsapp-web.js',
  'src',
  'util',
  'Injected',
  'Utils.js'
);

const marker = 'delete message.__x_id;';
const anchor = '        // Bot\'s won\'t reply if canonicalUrl is set (linking)';

if (!fs.existsSync(target)) {
  console.log('[WA PATCH] whatsapp-web.js source not found; skipping.');
  process.exit(0);
}

let source = fs.readFileSync(target, 'utf8');

if (source.includes(marker)) {
  console.log('[WA PATCH] __x_id hotfix already applied.');
  process.exit(0);
}

if (!source.includes(anchor)) {
  console.error('[WA PATCH] Could not find whatsapp-web.js sendMessage injection anchor.');
  process.exit(1);
}

source = source.replace(
  anchor,
  [
    '        // Hotfix for WhatsApp Web 2.3000.x media-send regression.',
    '        // MediaData.__x_id overwrites Msg.id and causes getValidatedSender()',
    '        // to throw: Data passed to getter must include an id property.',
    '        delete message.__x_id;',
    '',
    anchor,
  ].join('\n')
);

fs.writeFileSync(target, source, 'utf8');
console.log('[WA PATCH] Applied whatsapp-web.js media-send __x_id hotfix.');
