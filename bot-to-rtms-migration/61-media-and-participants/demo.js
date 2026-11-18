import { runMediaDemo } from './offlineDemo.js';

const result = runMediaDemo();
console.log('offline media demo: canned RTMS events, no credentials and no network');
console.log(`participants: ${result.participants.participants.map((person) => `${person.user_id}:${person.names.at(-1).name}`).join(', ')}`);
console.log(`subscriptions: ${result.sent.map((message) => `${message.user_id}:${message.subscribe ? 'subscribe' : 'unsubscribe'}`).join(', ')}`);
for (const frame of result.frames) console.log(`frame ${frame.timestamp} user ${frame.userId}: ${frame.attributed ? 'attributed' : 'unattributed'}`);
for (const sample of result.audioSamples) console.log(`audio ${sample.timestamp} user ${sample.userId}: ${sample.basis}`);
console.log(`negotiated audio ${JSON.stringify(result.mediaParams.audio)}`);
console.log(`negotiated video ${JSON.stringify(result.mediaParams.video)}`);
console.log('Meeting SDK translation notes:');
for (const note of result.sdkTranslation.notes) console.log(`- ${note}`);
console.log('offline demo complete');
