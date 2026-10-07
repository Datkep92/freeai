import { run } from './harness.js';
import { registerDbCases } from './cases-db.js';
import { registerCoreCases } from './cases-core.js';
import { registerVerifyCases } from './cases-verify.js';
import { registerWiringCases } from './cases-wiring.js';
import { registerIoCases } from './cases-io.js';
import { registerUiCases } from './cases-ui.js';
import { registerRotationCases } from './cases-rotation.js';
import { registerKeyReqCases } from './cases-keyreq.js';
import { registerRouterLockCases } from './cases-router-locks.js';
import { registerShellCases } from './cases-shell.js';
import { registerModelInfoCases } from './cases-model-info.js';

registerDbCases();
registerCoreCases();
registerVerifyCases();
registerWiringCases();
registerIoCases();
registerUiCases();
registerRotationCases();
registerKeyReqCases();
registerRouterLockCases();
registerShellCases();
registerModelInfoCases();

const ok = await run();
process.exit(ok ? 0 : 1);
