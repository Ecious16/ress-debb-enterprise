'use strict';

// Copies Font Awesome's CSS and webfonts into public/ so the site serves its own icons (no CDN).
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', '@fortawesome', 'fontawesome-free');
const dest = path.join(__dirname, '..', 'public', 'vendor', 'fontawesome');

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(path.join(dest, 'css'), { recursive: true });
fs.copyFileSync(path.join(src, 'css', 'all.min.css'), path.join(dest, 'css', 'all.min.css'));
fs.cpSync(path.join(src, 'webfonts'), path.join(dest, 'webfonts'), { recursive: true });
console.log('Font Awesome copied to public/vendor/fontawesome');