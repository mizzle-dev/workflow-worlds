/**
 * Event Sourcing Contract Tests for Redis World
 */

import { eventSourcingTests } from '@workflow-worlds/testing';
import { createStorage } from './setup.js';

eventSourcingTests({ createStorage });
