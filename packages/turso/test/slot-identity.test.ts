/**
 * Slot Identity Tests for Turso World
 */

import { slotIdentityTests } from '@workflow-worlds/testing';
import { createStorage } from './setup.js';

slotIdentityTests({ createStorage });
