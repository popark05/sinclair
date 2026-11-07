import { createMemoryEventStore } from '../src/index.ts';
import { eventStoreSuite } from './event-store-suite.ts';

eventStoreSuite('memory', () => createMemoryEventStore());
