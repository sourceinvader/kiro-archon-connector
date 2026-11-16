#!/usr/bin/env bun
/**
 * archon-provider-kiro: an Archon provider plugin process. Archon starts it and speaks
 * newline-delimited JSON-RPC on stdin/stdout, so nothing else may ever write to stdout.
 */
import { serveProvider } from '@archon/provider-contract/plugin';
import { descriptor } from './descriptor';
import { KiroProvider } from './provider';

// Route any stray console output away from the RPC channel.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

await serveProvider({ descriptor, create: log => new KiroProvider(log) });
