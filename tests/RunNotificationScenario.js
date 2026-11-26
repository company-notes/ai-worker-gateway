import { createInterface } from 'node:readline';
import { NotificationScenario } from './NotificationScenario.js';

/** Test fixture process controlled by the Studio acceptance client over stdin. */
const scenario = new NotificationScenario();
try {
    await scenario.start();
    console.log(JSON.stringify({ address: scenario.address, webhookURL: scenario.webhookURL,
        clientToken: NotificationScenario.clientToken }));

    const commands = createInterface({ input: process.stdin });
    for await (const line of commands) {
        const command = JSON.parse(line);
        if (command.jobId) {
            await scenario.finish(command.jobId);
        }
        console.log(JSON.stringify({ callbacks: scenario.callbacks, dispatches: scenario.dispatches }));
    }
} finally {
    await scenario.close();
}
