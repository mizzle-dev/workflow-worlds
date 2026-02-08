/**
 * Event Sourcing Contract Tests for Turso World
 */

import { eventSourcingTests } from '@workflow-worlds/testing';
import { createStorage } from './setup.js';

eventSourcingTests({ createStorage });
