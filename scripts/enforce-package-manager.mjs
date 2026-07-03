const userAgent = process.env.npm_config_user_agent ?? '';

if (userAgent.startsWith('pnpm/')) {
  process.exit(0);
}

const manager = userAgent.split(' ')[0] || 'unknown package manager';

console.error('');
console.error('This repo uses pnpm@10.33.2.');
console.error(`Detected: ${manager}`);
console.error('Run "pnpm install" instead of "npm install".');
console.error('');

process.exit(1);
