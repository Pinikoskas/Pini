const { main } = require('./src/agent');

main().catch((e) => {
  console.error('שגיאה:', e.message);
  process.exit(1);
});
