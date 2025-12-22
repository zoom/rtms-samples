import dotenv from 'dotenv';

dotenv.config();
console.log('Loading environment configuration...');

export const config = {
    port: process.env.PORT || 3000,
    mode: process.env.MODE || 'webhook',
    webhookPath: process.env.WEBHOOK_PATH || '/webhook',
    clientId: process.env.ZOOM_CLIENT_ID,
    clientSecret: process.env.ZOOM_CLIENT_SECRET,
    zoomSecretToken: process.env.ZOOM_SECRET_TOKEN!
};

console.log('Configuration loaded:');
console.log(`   Mode: ${config.mode}`);
console.log(`   Port: ${config.port}`);
console.log(`   Webhook Path: ${config.webhookPath}`);
console.log(`   Client ID: ${config.clientId ? 'Set' : 'Not set'}`);
console.log(`   Client Secret: ${config.clientSecret ? 'Set' : 'Not set'}`);

