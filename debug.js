process.on('unhandledRejection', (reason, promise) => {
  console.error(' UNHANDLED REJECTION:', reason);
});
process.on('uncaughtException', (error) => {
  console.error(' UNCAUGHT EXCEPTION:', error);
});
import('./src/server.js')
  .then(() => console.log(' server.js loaded successfully'))
  .catch(e => console.error(' server.js failed:', e));
