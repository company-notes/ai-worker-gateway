import { WorkerConfig } from './WorkerConfig.js';
import { WorkerGateway } from './WorkerGateway.js';

const gateway = new WorkerGateway(WorkerConfig.fromEnvironment());
const address = await gateway.listen();
console.info(`AI Worker Gateway listening on ${address.address}:${address.port}`);
