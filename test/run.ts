/** Run pure-module tests first, then provider and store tests in sequence */

import { finish } from './harness';

import './parser.test';
import './lookup.test';
import './architecture.test';
import { done } from './providers.test';
import { run as runStoreTests } from './store.test';
import './harness.test';

finish(done.then(() => runStoreTests()));
