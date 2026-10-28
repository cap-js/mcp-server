import { detectRuntime } from './04-parse-blocks.js';
import { isPure, runtimesOf, projectForRuntime } from '../helpers.js';

// Splits section blocks into runtime-labelled groups.
// Each group's `blocks` is ready to pass into packBlocks.
export function splitByRuntime(blocks, heading) {
    const headingRuntime = detectRuntime(heading);

    if (headingRuntime) {
        const opposite = headingRuntime === 'java' ? 'node' : 'java';
        const primary = blocks.filter(b => !isPure(b, opposite));
        const oppositeBlocks = blocks.filter(b => isPure(b, opposite));
        const groups = [{ blocks: primary, label: headingRuntime }];
        if (oppositeBlocks.length > 0) groups.push({ blocks: oppositeBlocks, label: opposite });
        return groups;
    }

    const hasJava = blocks.some(b => runtimesOf(b).has('java'));
    const hasNode = blocks.some(b => runtimesOf(b).has('node'));

    if (hasJava && hasNode) {
        const javaBlocks = blocks.filter(b => !isPure(b, 'node')).map(b => projectForRuntime(b, 'java'));
        const nodeBlocks = blocks.filter(b => !isPure(b, 'java')).map(b => projectForRuntime(b, 'node'));
        return [{ blocks: javaBlocks, label: 'java' }, { blocks: nodeBlocks, label: 'node' }];
    }

    const label = hasJava ? 'java' : hasNode ? 'node' : undefined;
    const groups = [{ blocks, label }];
    if (label) {
        const nb = blocks.filter(b => !isPure(b, label));
        if (nb.length > 0) groups.push({ blocks: nb, label: undefined });
    }
    return groups;
}
