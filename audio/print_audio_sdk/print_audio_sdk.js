// Load environment variables from .env file
import 'dotenv/config';

import rtms from "@zoom/rtms";

rtms.onWebhookEvent(({event, payload}) => {
    console.log(event, payload)
 
    if (event !== "meeting.rtms_started") 
        return

    const client = new rtms.Client()
    
    client.onAudioData((data) => {
        // Convert Buffer to base64
        const base64Data = data.toString('base64');
        
        // Print the data in base64 format
        console.log("Base64 data:", base64Data);
    });
    
    client.join(payload)
});