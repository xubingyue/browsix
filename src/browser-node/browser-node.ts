/// <reference path="../../typings/node/node.d.ts" />
/// <reference path="../../typings/promise.d.ts" />
/// <reference path="../../node_modules/ts-stream/ts-stream.d.ts" />

'use strict';

import { now } from './ipc';
import { syscall, SyscallCallback, SyscallResponse } from './syscall';

import * as bindingBuffer from './binding/buffer';
import * as bindingUV from './binding/uv';
import * as bindingFs from './binding/fs';
import * as bindingFsEventWrap from './binding/fs_event_wrap';
import * as bindingConstants from './binding/constants';
import * as bindingContextify from './binding/contextify';
import * as bindingProcessWrap from './binding/process_wrap';
import * as bindingPipeWrap from './binding/pipe_wrap';
import * as bindingTTYWrap from './binding/tty_wrap';
import * as bindingSpawnSync from './binding/spawn_sync';
import * as bindingUtil from './binding/util';

class Process {
	argv: string[];
	env: Environment;
	pwd: string;
	queue: any[] = [];
	draining: boolean = false;

	stdin: any;
	stdout: any;
	stderr: any;

	constructor(argv: string[], environ: Environment) {
		this.argv = argv;
		this.env = environ;
	}

	init(cb: SyscallCallback): void {
		// TODO: getcwd has to be called first, as node makes
		// access to it syncronous, and with our
		// message-passing syscall interface every syscall is
		// async.  This has to be kept up to date with any
		// calls to chdir(2).
		syscall.getcwd((cwd: string) => {
			this.pwd = cwd;
			setTimeout(cb);
		});
	}

	cwd(): string {
		return this.pwd;
	}

	exit(code: number): void {
		// FIXME: we should make sure stdout and stderr are
		// flushed.
		//this.stdout.end();
		//this.stderr.end();

		// ending the above streams I think calls close() via
		// nextTick, if exit isn't called via setTimeout under
		// node it deadlock's the WebWorker-threads :\
		setTimeout(function(): void { syscall.exit(code); }, 0);
	}

	binding(name: string): any {
		switch (name) {
		case 'buffer':
			return bindingBuffer;
		case 'uv':
			return bindingUV;
		case 'fs':
			return bindingFs;
		case 'fs_event_wrap':
			return bindingFsEventWrap;
		case 'constants':
			return bindingConstants;
		case 'contextify':
			return bindingContextify;
		case 'process_wrap':
			return bindingProcessWrap;
		case 'pipe_wrap':
			return bindingPipeWrap;
		case 'tty_wrap':
			return bindingTTYWrap;
		case 'spawn_sync':
			return bindingSpawnSync;
		case 'util':
			return bindingUtil;
		default:
			console.log('TODO: unimplemented binding ' + name);
			(<any>console).trace('TODO: unimplemented binding ' + name);
		}
		return null;
	}

	// this is from acorn
	nextTick(fun: any, ...args: any[]): void {
		this.queue.push([fun, args]);
		if (!this.draining) {
			setTimeout(this.drainQueue.bind(this), 0);
		}
	}

	// this is from acorn
	private drainQueue(): void {
		if (this.draining) {
			return;
		}
		this.draining = true;
		let currentQueue: any[];
		let len = this.queue.length;
		while (len) {
			currentQueue = this.queue;
			this.queue = [];
			let i = -1;
			while (++i < len) {
				let [fn, args] = currentQueue[i];
				fn.apply(this, args);
			}
			len = this.queue.length;
		}
		this.draining = false;
	}
}
let process = new Process(undefined, { NODE_DEBUG: 'fs' });
(<any>self).process = process;

if (typeof (<any>self).setTimeout === 'undefined')
	(<any>self).setTimeout = superSadSetTimeout;

import * as fs from './fs';

declare var thread: any;
// node-WebWorker-threads doesn't support setTimeout becuase I think
// they want me to sink into depression.
function superSadSetTimeout(cb: any, ms: any, ...args: any[]): void {
	'use strict';
	return (<any>thread).nextTick(cb.bind.apply(cb, [this].concat(args)));
}

interface Environment {
	[name: string]: string;
}

function pipe2(cb: (err: any, rfd: number, wfd: number) => void): void {
	syscall.pipe2(0, cb);
}

function _require(moduleName: string): any {
	'use strict';

	switch (moduleName) {
	case 'fs':
		return fs;
	case 'child_process':
		return require('./child_process');
	case 'path':
		return require('./path');
	case 'readline':
		return require('./readline');
	case 'node-pipe2':
		return pipe2;
	default:
		throw new ReferenceError('unknown module ' + moduleName);
	}
}

syscall.addEventListener('init', init.bind(this));
function init(data: SyscallResponse): void {
	'use strict';

	let args = data.args[0];
	let environ = data.args[1];
	process.argv = args;
	process.env = environ;
	process.stdin = new fs.createReadStream('<stdin>', {fd: 0});
	process.stdout = new fs.createWriteStream('<stdout>', {fd: 1});
	process.stderr = new fs.createWriteStream('<stderr>', {fd: 2});

	process.init(() => {
		fs.readFile(args[1], 'utf-8', (err: any, contents: string) => {
			if (err) {
				process.stderr.write('error: ' + err, () => {
					process.exit(1);
				});
			}

			// this is what node does in Module._compile.
			contents = contents.replace(/^\#\!.*/, '');

			(<any>self).process = process;
			(<any>self).require = _require;
			try {
				(<any>self).eval(contents);
			} catch (e) {
				console.log(e);
			}
		});
	});
}
