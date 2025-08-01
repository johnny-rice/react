/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Chunk, BinaryChunk, Destination} from './ReactServerStreamConfig';

import type {Postpone} from 'react/src/ReactPostpone';

import type {TemporaryReferenceSet} from './ReactFlightServerTemporaryReferences';

import {
  enablePostpone,
  enableHalt,
  enableTaint,
  enableProfilerTimer,
  enableComponentPerformanceTrack,
  enableAsyncDebugInfo,
} from 'shared/ReactFeatureFlags';

import {
  scheduleWork,
  scheduleMicrotask,
  flushBuffered,
  beginWriting,
  writeChunkAndReturn,
  stringToChunk,
  typedArrayToBinaryChunk,
  byteLengthOfChunk,
  byteLengthOfBinaryChunk,
  completeWriting,
  close,
  closeWithError,
} from './ReactServerStreamConfig';

export type {Destination, Chunk} from './ReactServerStreamConfig';

import type {
  ClientManifest,
  ClientReferenceMetadata,
  ClientReference,
  ClientReferenceKey,
  ServerReference,
  ServerReferenceId,
  Hints,
  HintCode,
  HintModel,
} from './ReactFlightServerConfig';
import type {ThenableState} from './ReactFlightThenable';
import type {
  Wakeable,
  Thenable,
  PendingThenable,
  FulfilledThenable,
  RejectedThenable,
  ReactDebugInfo,
  ReactDebugInfoEntry,
  ReactComponentInfo,
  ReactIOInfo,
  ReactAsyncInfo,
  ReactStackTrace,
  ReactCallSite,
  ReactFunctionLocation,
  ReactErrorInfo,
  ReactErrorInfoDev,
} from 'shared/ReactTypes';
import type {ReactElement} from 'shared/ReactElementType';
import type {LazyComponent} from 'react/src/ReactLazy';
import type {
  AsyncSequence,
  IONode,
  PromiseNode,
  UnresolvedPromiseNode,
} from './ReactFlightAsyncSequence';

import {
  resolveClientReferenceMetadata,
  getServerReferenceId,
  getServerReferenceBoundArguments,
  getServerReferenceLocation,
  getClientReferenceKey,
  isClientReference,
  isServerReference,
  supportsRequestStorage,
  requestStorage,
  createHints,
  initAsyncDebugInfo,
  markAsyncSequenceRootTask,
  getCurrentAsyncSequence,
  getAsyncSequenceFromPromise,
  parseStackTrace,
  parseStackTracePrivate,
  supportsComponentStorage,
  componentStorage,
  unbadgeConsole,
} from './ReactFlightServerConfig';

import {
  resolveTemporaryReference,
  isOpaqueTemporaryReference,
} from './ReactFlightServerTemporaryReferences';

import {
  HooksDispatcher,
  prepareToUseHooksForRequest,
  prepareToUseHooksForComponent,
  getThenableStateAfterSuspending,
  getTrackedThenablesAfterRendering,
  resetHooksForRequest,
} from './ReactFlightHooks';
import {DefaultAsyncDispatcher} from './flight/ReactFlightAsyncDispatcher';

import {resolveOwner, setCurrentOwner} from './flight/ReactFlightCurrentOwner';

import {getOwnerStackByComponentInfoInDev} from 'shared/ReactComponentInfoStack';
import {resetOwnerStackLimit} from 'shared/ReactOwnerStackReset';

import noop from 'shared/noop';

import {
  callComponentInDEV,
  callLazyInitInDEV,
  callIteratorInDEV,
} from './ReactFlightCallUserSpace';

import {
  getIteratorFn,
  REACT_ELEMENT_TYPE,
  REACT_LEGACY_ELEMENT_TYPE,
  REACT_FORWARD_REF_TYPE,
  REACT_FRAGMENT_TYPE,
  REACT_LAZY_TYPE,
  REACT_MEMO_TYPE,
  REACT_POSTPONE_TYPE,
  ASYNC_ITERATOR,
} from 'shared/ReactSymbols';

import {
  describeObjectForErrorMessage,
  isGetter,
  isSimpleObject,
  jsxPropsParents,
  jsxChildrenParents,
  objectName,
} from 'shared/ReactSerializationErrors';

import ReactSharedInternals from './ReactSharedInternalsServer';
import isArray from 'shared/isArray';
import getPrototypeOf from 'shared/getPrototypeOf';
import hasOwnProperty from 'shared/hasOwnProperty';
import binaryToComparableString from 'shared/binaryToComparableString';

import {SuspenseException, getSuspendedThenable} from './ReactFlightThenable';

import {
  IO_NODE,
  PROMISE_NODE,
  AWAIT_NODE,
  UNRESOLVED_AWAIT_NODE,
  UNRESOLVED_PROMISE_NODE,
} from './ReactFlightAsyncSequence';

// DEV-only set containing internal objects that should not be limited and turned into getters.
const doNotLimit: WeakSet<Reference> = __DEV__ ? new WeakSet() : (null: any);

function defaultFilterStackFrame(
  filename: string,
  functionName: string,
): boolean {
  return (
    filename !== '' &&
    !filename.startsWith('node:') &&
    !filename.includes('node_modules')
  );
}

function devirtualizeURL(url: string): string {
  if (url.startsWith('about://React/')) {
    // This callsite is a virtual fake callsite that came from another Flight client.
    // We need to reverse it back into the original location by stripping its prefix
    // and suffix. We don't need the environment name because it's available on the
    // parent object that will contain the stack.
    const envIdx = url.indexOf('/', 'about://React/'.length);
    const suffixIdx = url.lastIndexOf('?');
    if (envIdx > -1 && suffixIdx > -1) {
      return decodeURI(url.slice(envIdx + 1, suffixIdx));
    }
  }
  return url;
}

function isPromiseCreationInternal(url: string, functionName: string): boolean {
  // Various internals of the JS VM can create Promises but the call frame of the
  // internals are not very interesting for our purposes so we need to skip those.
  if (url === 'node:internal/async_hooks') {
    // Ignore the stack frames from the async hooks themselves.
    return true;
  }
  if (url !== '') {
    return false;
  }
  switch (functionName) {
    case 'new Promise':
    case 'Function.withResolvers':
    case 'Function.reject':
    case 'Function.resolve':
    case 'Function.all':
    case 'Function.allSettled':
    case 'Function.race':
    case 'Function.try':
      return true;
    default:
      return false;
  }
}

function stripLeadingPromiseCreationFrames(
  stack: ReactStackTrace,
): ReactStackTrace {
  for (let i = 0; i < stack.length; i++) {
    const callsite = stack[i];
    const functionName = callsite[0];
    const url = callsite[1];
    if (!isPromiseCreationInternal(url, functionName)) {
      if (i > 0) {
        return stack.slice(i);
      } else {
        return stack;
      }
    }
  }
  return [];
}

function findCalledFunctionNameFromStackTrace(
  request: Request,
  stack: ReactStackTrace,
): string {
  // Gets the name of the first function called from first party code.
  let bestMatch = '';
  const filterStackFrame = request.filterStackFrame;
  for (let i = 0; i < stack.length; i++) {
    const callsite = stack[i];
    const functionName = callsite[0];
    const url = devirtualizeURL(callsite[1]);
    const lineNumber = callsite[2];
    const columnNumber = callsite[3];
    if (filterStackFrame(url, functionName, lineNumber, columnNumber)) {
      if (bestMatch === '') {
        // If we had no good stack frames for internal calls, just use the last
        // first party function name.
        return functionName;
      }
      return bestMatch;
    } else {
      bestMatch = functionName;
    }
  }
  return '';
}

function filterStackTrace(
  request: Request,
  stack: ReactStackTrace,
): ReactStackTrace {
  // Since stacks can be quite large and we pass a lot of them, we filter them out eagerly
  // to save bandwidth even in DEV. We'll also replay these stacks on the client so by
  // stripping them early we avoid that overhead. Otherwise we'd normally just rely on
  // the DevTools or framework's ignore lists to filter them out.
  const filterStackFrame = request.filterStackFrame;
  const filteredStack: ReactStackTrace = [];
  for (let i = 0; i < stack.length; i++) {
    const callsite = stack[i];
    const functionName = callsite[0];
    const url = devirtualizeURL(callsite[1]);
    const lineNumber = callsite[2];
    const columnNumber = callsite[3];
    if (filterStackFrame(url, functionName, lineNumber, columnNumber)) {
      // Use a clone because the Flight protocol isn't yet resilient to deduping
      // objects in the debug info. TODO: Support deduping stacks.
      const clone: ReactCallSite = (callsite.slice(0): any);
      clone[1] = url;
      filteredStack.push(clone);
    }
  }
  return filteredStack;
}

function hasUnfilteredFrame(request: Request, stack: ReactStackTrace): boolean {
  const filterStackFrame = request.filterStackFrame;
  for (let i = 0; i < stack.length; i++) {
    const callsite = stack[i];
    const functionName = callsite[0];
    const url = devirtualizeURL(callsite[1]);
    const lineNumber = callsite[2];
    const columnNumber = callsite[3];
    // Ignore async stack frames because they're not "real". We'd expect to have at least
    // one non-async frame if we're actually executing inside a first party function.
    // Otherwise we might just be in the resume of a third party function that resumed
    // inside a first party stack.
    const isAsync = callsite[6];
    if (
      !isAsync &&
      filterStackFrame(url, functionName, lineNumber, columnNumber)
    ) {
      return true;
    }
  }
  return false;
}

function isPromiseAwaitInternal(url: string, functionName: string): boolean {
  // Various internals of the JS VM can await internally on a Promise. If those are at
  // the top of the stack then we don't want to consider them as internal frames. The
  // true "await" conceptually is the thing that called the helper.
  // Ideally we'd also include common third party helpers for this.
  if (url === 'node:internal/async_hooks') {
    // Ignore the stack frames from the async hooks themselves.
    return true;
  }
  if (url !== '') {
    return false;
  }
  switch (functionName) {
    case 'Promise.then':
    case 'Promise.catch':
    case 'Promise.finally':
    case 'Function.reject':
    case 'Function.resolve':
    case 'Function.all':
    case 'Function.allSettled':
    case 'Function.race':
    case 'Function.try':
      return true;
    default:
      return false;
  }
}

export function isAwaitInUserspace(
  request: Request,
  stack: ReactStackTrace,
): boolean {
  let firstFrame = 0;
  while (
    stack.length > firstFrame &&
    isPromiseAwaitInternal(stack[firstFrame][1], stack[firstFrame][0])
  ) {
    // Skip the internal frame that awaits itself.
    firstFrame++;
  }
  if (stack.length > firstFrame) {
    // Check if the very first stack frame that awaited this Promise was in user space.
    // TODO: This doesn't take into account wrapper functions such as our fake .then()
    // in FlightClient which will always be considered third party awaits if you call
    // .then directly.
    const filterStackFrame = request.filterStackFrame;
    const callsite = stack[firstFrame];
    const functionName = callsite[0];
    const url = devirtualizeURL(callsite[1]);
    const lineNumber = callsite[2];
    const columnNumber = callsite[3];
    return filterStackFrame(url, functionName, lineNumber, columnNumber);
  }
  return false;
}

initAsyncDebugInfo();

function patchConsole(consoleInst: typeof console, methodName: string) {
  const descriptor = Object.getOwnPropertyDescriptor(consoleInst, methodName);
  if (
    descriptor &&
    (descriptor.configurable || descriptor.writable) &&
    typeof descriptor.value === 'function'
  ) {
    const originalMethod = descriptor.value;
    const originalName = Object.getOwnPropertyDescriptor(
      // $FlowFixMe[incompatible-call]: We should be able to get descriptors from any function.
      originalMethod,
      'name',
    );
    const wrapperMethod = function (this: typeof console) {
      const request = resolveRequest();
      if (methodName === 'assert' && arguments[0]) {
        // assert doesn't emit anything unless first argument is falsy so we can skip it.
      } else if (request !== null) {
        // Extract the stack. Not all console logs print the full stack but they have at
        // least the line it was called from. We could optimize transfer by keeping just
        // one stack frame but keeping it simple for now and include all frames.
        const stack = filterStackTrace(
          request,
          parseStackTracePrivate(new Error('react-stack-top-frame'), 1) || [],
        );
        request.pendingDebugChunks++;
        const owner: null | ReactComponentInfo = resolveOwner();
        const args = Array.from(arguments);
        // Extract the env if this is a console log that was replayed from another env.
        let env = unbadgeConsole(methodName, args);
        if (env === null) {
          // Otherwise add the current environment.
          env = (0, request.environmentName)();
        }

        emitConsoleChunk(request, methodName, owner, env, stack, args);
      }
      // $FlowFixMe[prop-missing]
      return originalMethod.apply(this, arguments);
    };
    if (originalName) {
      Object.defineProperty(
        wrapperMethod,
        // $FlowFixMe[cannot-write] yes it is
        'name',
        originalName,
      );
    }
    Object.defineProperty(consoleInst, methodName, {
      value: wrapperMethod,
    });
  }
}

if (__DEV__ && typeof console === 'object' && console !== null) {
  // Instrument console to capture logs for replaying on the client.
  patchConsole(console, 'assert');
  patchConsole(console, 'debug');
  patchConsole(console, 'dir');
  patchConsole(console, 'dirxml');
  patchConsole(console, 'error');
  patchConsole(console, 'group');
  patchConsole(console, 'groupCollapsed');
  patchConsole(console, 'groupEnd');
  patchConsole(console, 'info');
  patchConsole(console, 'log');
  patchConsole(console, 'table');
  patchConsole(console, 'trace');
  patchConsole(console, 'warn');
}

function getCurrentStackInDEV(): string {
  if (__DEV__) {
    const owner: null | ReactComponentInfo = resolveOwner();
    if (owner === null) {
      return '';
    }
    return getOwnerStackByComponentInfoInDev(owner);
  }
  return '';
}

const ObjectPrototype = Object.prototype;

type JSONValue =
  | string
  | boolean
  | number
  | null
  | {+[key: string]: JSONValue}
  | $ReadOnlyArray<JSONValue>;

const stringify = JSON.stringify;

type ReactJSONValue =
  | string
  | boolean
  | number
  | null
  | $ReadOnlyArray<ReactClientValue>
  | ReactClientObject;

// Serializable values
export type ReactClientValue =
  // Server Elements and Lazy Components are unwrapped on the Server
  | React$Element<React$ComponentType<any>>
  | LazyComponent<ReactClientValue, any>
  // References are passed by their value
  | ClientReference<any>
  | ServerReference<any>
  // The rest are passed as is. Sub-types can be passed in but lose their
  // subtype, so the receiver can only accept once of these.
  | React$Element<string>
  | React$Element<ClientReference<any> & any>
  | ReactComponentInfo
  | string
  | boolean
  | number
  | symbol
  | null
  | void
  | bigint
  | ReadableStream
  | $AsyncIterable<ReactClientValue, ReactClientValue, void>
  | $AsyncIterator<ReactClientValue, ReactClientValue, void>
  | Iterable<ReactClientValue>
  | Iterator<ReactClientValue>
  | Array<ReactClientValue>
  | Map<ReactClientValue, ReactClientValue>
  | Set<ReactClientValue>
  | FormData
  | $ArrayBufferView
  | ArrayBuffer
  | Date
  | ReactClientObject
  | Promise<ReactClientValue>; // Thenable<ReactClientValue>

type ReactClientObject = {+[key: string]: ReactClientValue};

// task status
const PENDING = 0;
const COMPLETED = 1;
const ABORTED = 3;
const ERRORED = 4;
const RENDERING = 5;

type Task = {
  id: number,
  status: 0 | 1 | 3 | 4 | 5,
  model: ReactClientValue,
  ping: () => void,
  toJSON: (key: string, value: ReactClientValue) => ReactJSONValue,
  keyPath: null | string, // parent server component keys
  implicitSlot: boolean, // true if the root server component of this sequence had a null key
  thenableState: ThenableState | null,
  timed: boolean, // Profiling-only. Whether we need to track the completion time of this task.
  time: number, // Profiling-only. The last time stamp emitted for this task.
  environmentName: string, // DEV-only. Used to track if the environment for this task changed.
  debugOwner: null | ReactComponentInfo, // DEV-only
  debugStack: null | Error, // DEV-only
  debugTask: null | ConsoleTask, // DEV-only
};

interface Reference {}

type ReactClientReference = Reference & ReactClientValue;

type DeferredDebugStore = {
  retained: Map<number, ReactClientReference | string>,
  existing: Map<ReactClientReference | string, number>,
};

const OPENING = 10;
const OPEN = 11;
const ABORTING = 12;
const CLOSING = 13;
const CLOSED = 14;

const RENDER = 20;
const PRERENDER = 21;

export type Request = {
  status: 10 | 11 | 12 | 13 | 14,
  type: 20 | 21,
  flushScheduled: boolean,
  fatalError: mixed,
  destination: null | Destination,
  bundlerConfig: ClientManifest,
  cache: Map<Function, mixed>,
  cacheController: AbortController,
  nextChunkId: number,
  pendingChunks: number,
  hints: Hints,
  abortableTasks: Set<Task>,
  pingedTasks: Array<Task>,
  completedImportChunks: Array<Chunk>,
  completedHintChunks: Array<Chunk>,
  completedRegularChunks: Array<Chunk | BinaryChunk>,
  completedErrorChunks: Array<Chunk>,
  writtenSymbols: Map<symbol, number>,
  writtenClientReferences: Map<ClientReferenceKey, number>,
  writtenServerReferences: Map<ServerReference<any>, number>,
  writtenObjects: WeakMap<Reference, string>,
  temporaryReferences: void | TemporaryReferenceSet,
  identifierPrefix: string,
  identifierCount: number,
  taintCleanupQueue: Array<string | bigint>,
  onError: (error: mixed) => ?string,
  onPostpone: (reason: string) => void,
  onAllReady: () => void,
  onFatalError: mixed => void,
  // Profiling-only
  timeOrigin: number,
  abortTime: number,
  // DEV-only
  pendingDebugChunks: number,
  completedDebugChunks: Array<Chunk | BinaryChunk>,
  debugDestination: null | Destination,
  environmentName: () => string,
  filterStackFrame: (
    url: string,
    functionName: string,
    lineNumber: number,
    columnNumber: number,
  ) => boolean,
  didWarnForKey: null | WeakSet<ReactComponentInfo>,
  writtenDebugObjects: WeakMap<Reference, string>,
  deferredDebugObjects: null | DeferredDebugStore,
};

const {
  TaintRegistryObjects,
  TaintRegistryValues,
  TaintRegistryByteLengths,
  TaintRegistryPendingRequests,
} = ReactSharedInternals;

function throwTaintViolation(message: string) {
  // eslint-disable-next-line react-internal/prod-error-codes
  throw new Error(message);
}

function cleanupTaintQueue(request: Request): void {
  const cleanupQueue = request.taintCleanupQueue;
  TaintRegistryPendingRequests.delete(cleanupQueue);
  for (let i = 0; i < cleanupQueue.length; i++) {
    const entryValue = cleanupQueue[i];
    const entry = TaintRegistryValues.get(entryValue);
    if (entry !== undefined) {
      if (entry.count === 1) {
        TaintRegistryValues.delete(entryValue);
      } else {
        entry.count--;
      }
    }
  }
  cleanupQueue.length = 0;
}

function defaultErrorHandler(error: mixed) {
  console['error'](error);
  // Don't transform to our wrapper
}

const defaultPostponeHandler: (reason: string) => void = noop;

function RequestInstance(
  this: $FlowFixMe,
  type: 20 | 21,
  model: ReactClientValue,
  bundlerConfig: ClientManifest,
  onError: void | ((error: mixed) => ?string),
  onPostpone: void | ((reason: string) => void),
  onAllReady: () => void,
  onFatalError: (error: mixed) => void,
  identifierPrefix?: string,
  temporaryReferences: void | TemporaryReferenceSet,
  environmentName: void | string | (() => string), // DEV-only
  filterStackFrame: void | ((url: string, functionName: string) => boolean), // DEV-only
  keepDebugAlive: boolean, // DEV-only
) {
  if (
    ReactSharedInternals.A !== null &&
    ReactSharedInternals.A !== DefaultAsyncDispatcher
  ) {
    throw new Error(
      'Currently React only supports one RSC renderer at a time.',
    );
  }
  ReactSharedInternals.A = DefaultAsyncDispatcher;
  if (__DEV__) {
    // Unlike Fizz or Fiber, we don't reset this and just keep it on permanently.
    // This lets it act more like the AsyncDispatcher so that we can get the
    // stack asynchronously too.
    ReactSharedInternals.getCurrentStack = getCurrentStackInDEV;
  }

  const abortSet: Set<Task> = new Set();
  const pingedTasks: Array<Task> = [];
  const cleanupQueue: Array<string | bigint> = [];
  if (enableTaint) {
    TaintRegistryPendingRequests.add(cleanupQueue);
  }
  const hints = createHints();
  this.type = type;
  this.status = OPENING;
  this.flushScheduled = false;
  this.fatalError = null;
  this.destination = null;
  this.bundlerConfig = bundlerConfig;
  this.cache = new Map();
  this.cacheController = new AbortController();
  this.nextChunkId = 0;
  this.pendingChunks = 0;
  this.hints = hints;
  this.abortableTasks = abortSet;
  this.pingedTasks = pingedTasks;
  this.completedImportChunks = ([]: Array<Chunk>);
  this.completedHintChunks = ([]: Array<Chunk>);
  this.completedRegularChunks = ([]: Array<Chunk | BinaryChunk>);
  this.completedErrorChunks = ([]: Array<Chunk>);
  this.writtenSymbols = new Map();
  this.writtenClientReferences = new Map();
  this.writtenServerReferences = new Map();
  this.writtenObjects = new WeakMap();
  this.temporaryReferences = temporaryReferences;
  this.identifierPrefix = identifierPrefix || '';
  this.identifierCount = 1;
  this.taintCleanupQueue = cleanupQueue;
  this.onError = onError === undefined ? defaultErrorHandler : onError;
  this.onPostpone =
    onPostpone === undefined ? defaultPostponeHandler : onPostpone;
  this.onAllReady = onAllReady;
  this.onFatalError = onFatalError;

  if (__DEV__) {
    this.pendingDebugChunks = 0;
    this.completedDebugChunks = ([]: Array<Chunk>);
    this.debugDestination = null;
    this.environmentName =
      environmentName === undefined
        ? () => 'Server'
        : typeof environmentName !== 'function'
          ? () => environmentName
          : environmentName;
    this.filterStackFrame =
      filterStackFrame === undefined
        ? defaultFilterStackFrame
        : filterStackFrame;
    this.didWarnForKey = null;
    this.writtenDebugObjects = new WeakMap();
    this.deferredDebugObjects = keepDebugAlive
      ? {
          retained: new Map(),
          existing: new Map(),
        }
      : null;
  }

  let timeOrigin: number;
  if (
    enableProfilerTimer &&
    (enableComponentPerformanceTrack || enableAsyncDebugInfo)
  ) {
    // We start by serializing the time origin. Any future timestamps will be
    // emitted relatively to this origin. Instead of using performance.timeOrigin
    // as this origin, we use the timestamp at the start of the request.
    // This avoids leaking unnecessary information like how long the server has
    // been running and allows for more compact representation of each timestamp.
    // The time origin is stored as an offset in the time space of this environment.
    timeOrigin = this.timeOrigin = performance.now();
    emitTimeOriginChunk(
      this,
      timeOrigin +
        // $FlowFixMe[prop-missing]
        performance.timeOrigin,
    );
    this.abortTime = -0.0;
  } else {
    timeOrigin = 0;
  }

  const rootTask = createTask(
    this,
    model,
    null,
    false,
    abortSet,
    timeOrigin,
    null,
    null,
    null,
  );
  pingedTasks.push(rootTask);
}

export function createRequest(
  model: ReactClientValue,
  bundlerConfig: ClientManifest,
  onError: void | ((error: mixed) => ?string),
  identifierPrefix: void | string,
  onPostpone: void | ((reason: string) => void),
  temporaryReferences: void | TemporaryReferenceSet,
  environmentName: void | string | (() => string), // DEV-only
  filterStackFrame: void | ((url: string, functionName: string) => boolean), // DEV-only
  keepDebugAlive: boolean, // DEV-only
): Request {
  if (__DEV__) {
    resetOwnerStackLimit();
  }

  // $FlowFixMe[invalid-constructor]: the shapes are exact here but Flow doesn't like constructors
  return new RequestInstance(
    RENDER,
    model,
    bundlerConfig,
    onError,
    onPostpone,
    noop,
    noop,
    identifierPrefix,
    temporaryReferences,
    environmentName,
    filterStackFrame,
    keepDebugAlive,
  );
}

export function createPrerenderRequest(
  model: ReactClientValue,
  bundlerConfig: ClientManifest,
  onAllReady: () => void,
  onFatalError: () => void,
  onError: void | ((error: mixed) => ?string),
  identifierPrefix: void | string,
  onPostpone: void | ((reason: string) => void),
  temporaryReferences: void | TemporaryReferenceSet,
  environmentName: void | string | (() => string), // DEV-only
  filterStackFrame: void | ((url: string, functionName: string) => boolean), // DEV-only
  keepDebugAlive: boolean, // DEV-only
): Request {
  if (__DEV__) {
    resetOwnerStackLimit();
  }

  // $FlowFixMe[invalid-constructor]: the shapes are exact here but Flow doesn't like constructors
  return new RequestInstance(
    PRERENDER,
    model,
    bundlerConfig,
    onError,
    onPostpone,
    onAllReady,
    onFatalError,
    identifierPrefix,
    temporaryReferences,
    environmentName,
    filterStackFrame,
    keepDebugAlive,
  );
}

let currentRequest: null | Request = null;

export function resolveRequest(): null | Request {
  if (currentRequest) return currentRequest;
  if (supportsRequestStorage) {
    const store = requestStorage.getStore();
    if (store) return store;
  }
  return null;
}

function serializeDebugThenable(
  request: Request,
  counter: {objectLimit: number},
  thenable: Thenable<any>,
): string {
  // Like serializeThenable but for renderDebugModel
  request.pendingDebugChunks++;
  const id = request.nextChunkId++;
  const ref = serializePromiseID(id);
  request.writtenDebugObjects.set(thenable, ref);

  switch (thenable.status) {
    case 'fulfilled': {
      emitOutlinedDebugModelChunk(request, id, counter, thenable.value);
      return ref;
    }
    case 'rejected': {
      const x = thenable.reason;
      // We don't log these errors since they didn't actually throw into Flight.
      const digest = '';
      emitErrorChunk(request, id, digest, x, true);
      return ref;
    }
  }

  if (request.status === ABORTING) {
    // Ensure that we have time to emit the halt chunk if we're sync aborting.
    emitDebugHaltChunk(request, id);
    return ref;
  }

  const deferredDebugObjects = request.deferredDebugObjects;
  if (deferredDebugObjects !== null) {
    // For Promises that are not yet resolved, we always defer them. They are async anyway so it's
    // safe to defer them. This also ensures that we don't eagerly call .then() on a Promise that
    // otherwise wouldn't have initialized. It also ensures that we don't "handle" a rejection
    // that otherwise would have triggered unhandled rejection.
    deferredDebugObjects.retained.set(id, (thenable: any));
    const deferredRef = '$Y@' + id.toString(16);
    // We can now refer to the deferred object in the future.
    request.writtenDebugObjects.set(thenable, deferredRef);
    return deferredRef;
  }

  let cancelled = false;

  thenable.then(
    value => {
      if (cancelled) {
        return;
      }
      cancelled = true;
      if (request.status === ABORTING) {
        emitDebugHaltChunk(request, id);
        enqueueFlush(request);
        return;
      }
      emitOutlinedDebugModelChunk(request, id, counter, value);
      enqueueFlush(request);
    },
    reason => {
      if (cancelled) {
        return;
      }
      cancelled = true;
      if (request.status === ABORTING) {
        emitDebugHaltChunk(request, id);
        enqueueFlush(request);
        return;
      }
      // We don't log these errors since they didn't actually throw into Flight.
      const digest = '';
      emitErrorChunk(request, id, digest, reason, true);
      enqueueFlush(request);
    },
  );

  // We don't use scheduleMicrotask here because it doesn't actually schedule a microtask
  // in all our configs which is annoying.
  Promise.resolve().then(() => {
    // If we don't resolve the Promise within a microtask. Leave it as hanging since we
    // don't want to block the render forever on a Promise that might never resolve.
    if (cancelled) {
      return;
    }
    cancelled = true;
    emitDebugHaltChunk(request, id);
    enqueueFlush(request);
    // Clean up the request so we don't leak this forever.
    request = (null: any);
    counter = (null: any);
  });

  return ref;
}

function emitRequestedDebugThenable(
  request: Request,
  id: number,
  counter: {objectLimit: number},
  thenable: Thenable<any>,
): void {
  thenable.then(
    value => {
      if (request.status === ABORTING) {
        emitDebugHaltChunk(request, id);
        enqueueFlush(request);
        return;
      }
      emitOutlinedDebugModelChunk(request, id, counter, value);
      enqueueFlush(request);
    },
    reason => {
      if (request.status === ABORTING) {
        emitDebugHaltChunk(request, id);
        enqueueFlush(request);
        return;
      }
      // We don't log these errors since they didn't actually throw into Flight.
      const digest = '';
      emitErrorChunk(request, id, digest, reason, true);
      enqueueFlush(request);
    },
  );
}

function serializeThenable(
  request: Request,
  task: Task,
  thenable: Thenable<any>,
): number {
  const newTask = createTask(
    request,
    (thenable: any), // will be replaced by the value before we retry. used for debug info.
    task.keyPath, // the server component sequence continues through Promise-as-a-child.
    task.implicitSlot,
    request.abortableTasks,
    enableProfilerTimer &&
      (enableComponentPerformanceTrack || enableAsyncDebugInfo)
      ? task.time
      : 0,
    __DEV__ ? task.debugOwner : null,
    __DEV__ ? task.debugStack : null,
    __DEV__ ? task.debugTask : null,
  );

  switch (thenable.status) {
    case 'fulfilled': {
      forwardDebugInfoFromThenable(request, newTask, thenable, null, null);
      // We have the resolved value, we can go ahead and schedule it for serialization.
      newTask.model = thenable.value;
      pingTask(request, newTask);
      return newTask.id;
    }
    case 'rejected': {
      forwardDebugInfoFromThenable(request, newTask, thenable, null, null);
      const x = thenable.reason;
      erroredTask(request, newTask, x);
      return newTask.id;
    }
    default: {
      if (request.status === ABORTING) {
        // We can no longer accept any resolved values
        request.abortableTasks.delete(newTask);
        if (enableHalt && request.type === PRERENDER) {
          haltTask(newTask, request);
          finishHaltedTask(newTask, request);
        } else {
          const errorId: number = (request.fatalError: any);
          abortTask(newTask, request, errorId);
          finishAbortedTask(newTask, request, errorId);
        }
        return newTask.id;
      }
      if (typeof thenable.status === 'string') {
        // Only instrument the thenable if the status if not defined. If
        // it's defined, but an unknown value, assume it's been instrumented by
        // some custom userspace implementation. We treat it as "pending".
        break;
      }
      const pendingThenable: PendingThenable<mixed> = (thenable: any);
      pendingThenable.status = 'pending';
      pendingThenable.then(
        fulfilledValue => {
          if (thenable.status === 'pending') {
            const fulfilledThenable: FulfilledThenable<mixed> = (thenable: any);
            fulfilledThenable.status = 'fulfilled';
            fulfilledThenable.value = fulfilledValue;
          }
        },
        (error: mixed) => {
          if (thenable.status === 'pending') {
            const rejectedThenable: RejectedThenable<mixed> = (thenable: any);
            rejectedThenable.status = 'rejected';
            rejectedThenable.reason = error;
          }
        },
      );
      break;
    }
  }

  thenable.then(
    value => {
      forwardDebugInfoFromCurrentContext(request, newTask, thenable);
      newTask.model = value;
      pingTask(request, newTask);
    },
    reason => {
      if (newTask.status === PENDING) {
        if (
          enableProfilerTimer &&
          (enableComponentPerformanceTrack || enableAsyncDebugInfo)
        ) {
          // If this is async we need to time when this task finishes.
          newTask.timed = true;
        }
        // We expect that the only status it might be otherwise is ABORTED.
        // When we abort we emit chunks in each pending task slot and don't need
        // to do so again here.
        erroredTask(request, newTask, reason);
        enqueueFlush(request);
      }
    },
  );

  return newTask.id;
}

function serializeReadableStream(
  request: Request,
  task: Task,
  stream: ReadableStream,
): string {
  // Detect if this is a BYOB stream. BYOB streams should be able to be read as bytes on the
  // receiving side. It also implies that different chunks can be split up or merged as opposed
  // to a readable stream that happens to have Uint8Array as the type which might expect it to be
  // received in the same slices.
  // $FlowFixMe: This is a Node.js extension.
  let supportsBYOB: void | boolean = stream.supportsBYOB;
  if (supportsBYOB === undefined) {
    try {
      // $FlowFixMe[extra-arg]: This argument is accepted.
      stream.getReader({mode: 'byob'}).releaseLock();
      supportsBYOB = true;
    } catch (x) {
      supportsBYOB = false;
    }
  }

  const reader = stream.getReader();

  // This task won't actually be retried. We just use it to attempt synchronous renders.
  const streamTask = createTask(
    request,
    task.model,
    task.keyPath,
    task.implicitSlot,
    request.abortableTasks,
    enableProfilerTimer &&
      (enableComponentPerformanceTrack || enableAsyncDebugInfo)
      ? task.time
      : 0,
    __DEV__ ? task.debugOwner : null,
    __DEV__ ? task.debugStack : null,
    __DEV__ ? task.debugTask : null,
  );

  // The task represents the Stop row. This adds a Start row.
  request.pendingChunks++;
  const startStreamRow =
    streamTask.id.toString(16) + ':' + (supportsBYOB ? 'r' : 'R') + '\n';
  request.completedRegularChunks.push(stringToChunk(startStreamRow));

  function progress(entry: {done: boolean, value: ReactClientValue, ...}) {
    if (streamTask.status !== PENDING) {
      return;
    }

    if (entry.done) {
      streamTask.status = COMPLETED;
      const endStreamRow = streamTask.id.toString(16) + ':C\n';
      request.completedRegularChunks.push(stringToChunk(endStreamRow));
      request.abortableTasks.delete(streamTask);
      request.cacheController.signal.removeEventListener('abort', abortStream);
      enqueueFlush(request);
      callOnAllReadyIfReady(request);
    } else {
      try {
        streamTask.model = entry.value;
        request.pendingChunks++;
        tryStreamTask(request, streamTask);
        enqueueFlush(request);
        reader.read().then(progress, error);
      } catch (x) {
        error(x);
      }
    }
  }
  function error(reason: mixed) {
    if (streamTask.status !== PENDING) {
      return;
    }
    request.cacheController.signal.removeEventListener('abort', abortStream);
    erroredTask(request, streamTask, reason);
    enqueueFlush(request);

    // $FlowFixMe should be able to pass mixed
    reader.cancel(reason).then(error, error);
  }
  function abortStream() {
    if (streamTask.status !== PENDING) {
      return;
    }
    const signal = request.cacheController.signal;
    signal.removeEventListener('abort', abortStream);
    const reason = signal.reason;
    if (enableHalt && request.type === PRERENDER) {
      request.abortableTasks.delete(streamTask);
      haltTask(streamTask, request);
      finishHaltedTask(streamTask, request);
    } else {
      // TODO: Make this use abortTask() instead.
      erroredTask(request, streamTask, reason);
      enqueueFlush(request);
    }
    // $FlowFixMe should be able to pass mixed
    reader.cancel(reason).then(error, error);
  }

  request.cacheController.signal.addEventListener('abort', abortStream);
  reader.read().then(progress, error);
  return serializeByValueID(streamTask.id);
}

function serializeAsyncIterable(
  request: Request,
  task: Task,
  iterable: $AsyncIterable<ReactClientValue, ReactClientValue, void>,
  iterator: $AsyncIterator<ReactClientValue, ReactClientValue, void>,
): string {
  // Generators/Iterators are Iterables but they're also their own iterator
  // functions. If that's the case, we treat them as single-shot. Otherwise,
  // we assume that this iterable might be a multi-shot and allow it to be
  // iterated more than once on the client.
  const isIterator = iterable === iterator;

  // This task won't actually be retried. We just use it to attempt synchronous renders.
  const streamTask = createTask(
    request,
    task.model,
    task.keyPath,
    task.implicitSlot,
    request.abortableTasks,
    enableProfilerTimer &&
      (enableComponentPerformanceTrack || enableAsyncDebugInfo)
      ? task.time
      : 0,
    __DEV__ ? task.debugOwner : null,
    __DEV__ ? task.debugStack : null,
    __DEV__ ? task.debugTask : null,
  );

  if (__DEV__) {
    const debugInfo: ?ReactDebugInfo = (iterable: any)._debugInfo;
    if (debugInfo) {
      forwardDebugInfo(request, streamTask, debugInfo);
    }
  }

  // The task represents the Stop row. This adds a Start row.
  request.pendingChunks++;
  const startStreamRow =
    streamTask.id.toString(16) + ':' + (isIterator ? 'x' : 'X') + '\n';
  request.completedRegularChunks.push(stringToChunk(startStreamRow));

  function progress(
    entry:
      | {done: false, +value: ReactClientValue, ...}
      | {done: true, +value: ReactClientValue, ...},
  ) {
    if (streamTask.status !== PENDING) {
      return;
    }

    if (entry.done) {
      streamTask.status = COMPLETED;
      let endStreamRow;
      if (entry.value === undefined) {
        endStreamRow = streamTask.id.toString(16) + ':C\n';
      } else {
        // Unlike streams, the last value may not be undefined. If it's not
        // we outline it and encode a reference to it in the closing instruction.
        try {
          const chunkId = outlineModel(request, entry.value);
          endStreamRow =
            streamTask.id.toString(16) +
            ':C' +
            stringify(serializeByValueID(chunkId)) +
            '\n';
        } catch (x) {
          error(x);
          return;
        }
      }
      request.completedRegularChunks.push(stringToChunk(endStreamRow));
      request.abortableTasks.delete(streamTask);
      request.cacheController.signal.removeEventListener(
        'abort',
        abortIterable,
      );
      enqueueFlush(request);
      callOnAllReadyIfReady(request);
    } else {
      try {
        streamTask.model = entry.value;
        request.pendingChunks++;
        tryStreamTask(request, streamTask);
        enqueueFlush(request);
        if (__DEV__) {
          callIteratorInDEV(iterator, progress, error);
        } else {
          iterator.next().then(progress, error);
        }
      } catch (x) {
        error(x);
        return;
      }
    }
  }
  function error(reason: mixed) {
    if (streamTask.status !== PENDING) {
      return;
    }
    request.cacheController.signal.removeEventListener('abort', abortIterable);
    erroredTask(request, streamTask, reason);
    enqueueFlush(request);
    if (typeof (iterator: any).throw === 'function') {
      // The iterator protocol doesn't necessarily include this but a generator do.
      // $FlowFixMe should be able to pass mixed
      iterator.throw(reason).then(error, error);
    }
  }
  function abortIterable() {
    if (streamTask.status !== PENDING) {
      return;
    }
    const signal = request.cacheController.signal;
    signal.removeEventListener('abort', abortIterable);
    const reason = signal.reason;
    if (enableHalt && request.type === PRERENDER) {
      request.abortableTasks.delete(streamTask);
      haltTask(streamTask, request);
      finishHaltedTask(streamTask, request);
    } else {
      // TODO: Make this use abortTask() instead.
      erroredTask(request, streamTask, signal.reason);
      enqueueFlush(request);
    }
    if (typeof (iterator: any).throw === 'function') {
      // The iterator protocol doesn't necessarily include this but a generator do.
      // $FlowFixMe should be able to pass mixed
      iterator.throw(reason).then(error, error);
    }
  }
  request.cacheController.signal.addEventListener('abort', abortIterable);
  if (__DEV__) {
    callIteratorInDEV(iterator, progress, error);
  } else {
    iterator.next().then(progress, error);
  }
  return serializeByValueID(streamTask.id);
}

export function emitHint<Code: HintCode>(
  request: Request,
  code: Code,
  model: HintModel<Code>,
): void {
  emitHintChunk(request, code, model);
  enqueueFlush(request);
}

export function getHints(request: Request): Hints {
  return request.hints;
}

export function getCache(request: Request): Map<Function, mixed> {
  return request.cache;
}

function readThenable<T>(thenable: Thenable<T>): T {
  if (thenable.status === 'fulfilled') {
    return thenable.value;
  } else if (thenable.status === 'rejected') {
    throw thenable.reason;
  }
  throw thenable;
}

function createLazyWrapperAroundWakeable(
  request: Request,
  task: Task,
  wakeable: Wakeable,
) {
  // This is a temporary fork of the `use` implementation until we accept
  // promises everywhere.
  const thenable: Thenable<mixed> = (wakeable: any);
  switch (thenable.status) {
    case 'fulfilled': {
      forwardDebugInfoFromThenable(request, task, thenable, null, null);
      return thenable.value;
    }
    case 'rejected':
      forwardDebugInfoFromThenable(request, task, thenable, null, null);
      break;
    default: {
      if (typeof thenable.status === 'string') {
        // Only instrument the thenable if the status if not defined. If
        // it's defined, but an unknown value, assume it's been instrumented by
        // some custom userspace implementation. We treat it as "pending".
        break;
      }
      const pendingThenable: PendingThenable<mixed> = (thenable: any);
      pendingThenable.status = 'pending';
      pendingThenable.then(
        fulfilledValue => {
          forwardDebugInfoFromCurrentContext(request, task, thenable);
          if (thenable.status === 'pending') {
            const fulfilledThenable: FulfilledThenable<mixed> = (thenable: any);
            fulfilledThenable.status = 'fulfilled';
            fulfilledThenable.value = fulfilledValue;
          }
        },
        (error: mixed) => {
          forwardDebugInfoFromCurrentContext(request, task, thenable);
          if (thenable.status === 'pending') {
            const rejectedThenable: RejectedThenable<mixed> = (thenable: any);
            rejectedThenable.status = 'rejected';
            rejectedThenable.reason = error;
          }
        },
      );
      break;
    }
  }
  const lazyType: LazyComponent<any, Thenable<any>> = {
    $$typeof: REACT_LAZY_TYPE,
    _payload: thenable,
    _init: readThenable,
  };
  return lazyType;
}

function callWithDebugContextInDEV<A, T>(
  request: Request,
  task: Task,
  callback: A => T,
  arg: A,
): T {
  // We don't have a Server Component instance associated with this callback and
  // the nearest context is likely a Client Component being serialized. We create
  // a fake owner during this callback so we can get the stack trace from it.
  // This also gets sent to the client as the owner for the replaying log.
  const componentDebugInfo: ReactComponentInfo = {
    name: '',
    env: task.environmentName,
    key: null,
    owner: task.debugOwner,
  };
  // $FlowFixMe[cannot-write]
  componentDebugInfo.stack =
    task.debugStack === null
      ? null
      : filterStackTrace(request, parseStackTrace(task.debugStack, 1));
  // $FlowFixMe[cannot-write]
  componentDebugInfo.debugStack = task.debugStack;
  // $FlowFixMe[cannot-write]
  componentDebugInfo.debugTask = task.debugTask;
  const debugTask = task.debugTask;
  // We don't need the async component storage context here so we only set the
  // synchronous tracking of owner.
  setCurrentOwner(componentDebugInfo);
  try {
    if (debugTask) {
      return debugTask.run(callback.bind(null, arg));
    }
    return callback(arg);
  } finally {
    setCurrentOwner(null);
  }
}

const voidHandler = () => {};

function processServerComponentReturnValue(
  request: Request,
  task: Task,
  Component: any,
  result: any,
): any {
  // A Server Component's return value has a few special properties due to being
  // in the return position of a Component. We convert them here.
  if (
    typeof result !== 'object' ||
    result === null ||
    isClientReference(result)
  ) {
    return result;
  }

  if (typeof result.then === 'function') {
    // When the return value is in children position we can resolve it immediately,
    // to its value without a wrapper if it's synchronously available.
    const thenable: Thenable<any> = result;
    if (__DEV__) {
      // If the thenable resolves to an element, then it was in a static position,
      // the return value of a Server Component. That doesn't need further validation
      // of keys. The Server Component itself would have had a key.
      thenable.then(resolvedValue => {
        if (
          typeof resolvedValue === 'object' &&
          resolvedValue !== null &&
          resolvedValue.$$typeof === REACT_ELEMENT_TYPE
        ) {
          resolvedValue._store.validated = 1;
        }
      }, voidHandler);
    }
    // TODO: Once we accept Promises as children on the client, we can just return
    // the thenable here.
    return createLazyWrapperAroundWakeable(request, task, result);
  }

  if (__DEV__) {
    if ((result: any).$$typeof === REACT_ELEMENT_TYPE) {
      // If the server component renders to an element, then it was in a static position.
      // That doesn't need further validation of keys. The Server Component itself would
      // have had a key.
      (result: any)._store.validated = 1;
    }
  }

  // Normally we'd serialize an Iterator/AsyncIterator as a single-shot which is not compatible
  // to be rendered as a React Child. However, because we have the function to recreate
  // an iterable from rendering the element again, we can effectively treat it as multi-
  // shot. Therefore we treat this as an Iterable/AsyncIterable, whether it was one or not, by
  // adding a wrapper so that this component effectively renders down to an AsyncIterable.
  const iteratorFn = getIteratorFn(result);
  if (iteratorFn) {
    const iterableChild = result;
    const multiShot = {
      [Symbol.iterator]: function () {
        const iterator = iteratorFn.call(iterableChild);
        if (__DEV__) {
          // If this was an Iterator but not a GeneratorFunction we warn because
          // it might have been a mistake. Technically you can make this mistake with
          // GeneratorFunctions and even single-shot Iterables too but it's extra
          // tempting to try to return the value from a generator.
          if (iterator === iterableChild) {
            const isGeneratorComponent =
              // $FlowIgnore[method-unbinding]
              Object.prototype.toString.call(Component) ===
                '[object GeneratorFunction]' &&
              // $FlowIgnore[method-unbinding]
              Object.prototype.toString.call(iterableChild) ===
                '[object Generator]';
            if (!isGeneratorComponent) {
              callWithDebugContextInDEV(request, task, () => {
                console.error(
                  'Returning an Iterator from a Server Component is not supported ' +
                    'since it cannot be looped over more than once. ',
                );
              });
            }
          }
        }
        return (iterator: any);
      },
    };
    if (__DEV__) {
      (multiShot: any)._debugInfo = iterableChild._debugInfo;
    }
    return multiShot;
  }
  if (
    typeof (result: any)[ASYNC_ITERATOR] === 'function' &&
    (typeof ReadableStream !== 'function' ||
      !(result instanceof ReadableStream))
  ) {
    const iterableChild = result;
    const multishot = {
      [ASYNC_ITERATOR]: function () {
        const iterator = (iterableChild: any)[ASYNC_ITERATOR]();
        if (__DEV__) {
          // If this was an AsyncIterator but not an AsyncGeneratorFunction we warn because
          // it might have been a mistake. Technically you can make this mistake with
          // AsyncGeneratorFunctions and even single-shot AsyncIterables too but it's extra
          // tempting to try to return the value from a generator.
          if (iterator === iterableChild) {
            const isGeneratorComponent =
              // $FlowIgnore[method-unbinding]
              Object.prototype.toString.call(Component) ===
                '[object AsyncGeneratorFunction]' &&
              // $FlowIgnore[method-unbinding]
              Object.prototype.toString.call(iterableChild) ===
                '[object AsyncGenerator]';
            if (!isGeneratorComponent) {
              callWithDebugContextInDEV(request, task, () => {
                console.error(
                  'Returning an AsyncIterator from a Server Component is not supported ' +
                    'since it cannot be looped over more than once. ',
                );
              });
            }
          }
        }
        return iterator;
      },
    };
    if (__DEV__) {
      (multishot: any)._debugInfo = iterableChild._debugInfo;
    }
    return multishot;
  }
  return result;
}

function renderFunctionComponent<Props>(
  request: Request,
  task: Task,
  key: null | string,
  Component: (p: Props, arg: void) => any,
  props: Props,
  validated: number, // DEV-only
): ReactJSONValue {
  // Reset the task's thenable state before continuing, so that if a later
  // component suspends we can reuse the same task object. If the same
  // component suspends again, the thenable state will be restored.
  const prevThenableState = task.thenableState;
  task.thenableState = null;

  let result;

  let componentDebugInfo: ReactComponentInfo;
  if (__DEV__) {
    if (!canEmitDebugInfo) {
      // We don't have a chunk to assign debug info. We need to outline this
      // component to assign it an ID.
      return outlineTask(request, task);
    } else if (prevThenableState !== null) {
      // This is a replay and we've already emitted the debug info of this component
      // in the first pass. We skip emitting a duplicate line.
      // As a hack we stashed the previous component debug info on this object in DEV.
      componentDebugInfo = (prevThenableState: any)._componentDebugInfo;
    } else {
      // This is a new component in the same task so we can emit more debug info.
      const componentDebugID = task.id;
      const componentName =
        (Component: any).displayName || Component.name || '';
      const componentEnv = (0, request.environmentName)();
      request.pendingChunks++;
      componentDebugInfo = ({
        name: componentName,
        env: componentEnv,
        key: key,
        owner: task.debugOwner,
      }: ReactComponentInfo);
      // $FlowFixMe[cannot-write]
      componentDebugInfo.stack =
        task.debugStack === null
          ? null
          : filterStackTrace(request, parseStackTrace(task.debugStack, 1));
      // $FlowFixMe[cannot-write]
      componentDebugInfo.props = props;
      // $FlowFixMe[cannot-write]
      componentDebugInfo.debugStack = task.debugStack;
      // $FlowFixMe[cannot-write]
      componentDebugInfo.debugTask = task.debugTask;

      // We outline this model eagerly so that we can refer to by reference as an owner.
      // If we had a smarter way to dedupe we might not have to do this if there ends up
      // being no references to this as an owner.

      outlineComponentInfo(request, componentDebugInfo);

      // Track when we started rendering this component.
      if (
        enableProfilerTimer &&
        (enableComponentPerformanceTrack || enableAsyncDebugInfo)
      ) {
        advanceTaskTime(request, task, performance.now());
      }

      emitDebugChunk(request, componentDebugID, componentDebugInfo);

      // We've emitted the latest environment for this task so we track that.
      task.environmentName = componentEnv;

      if (validated === 2) {
        warnForMissingKey(request, key, componentDebugInfo, task.debugTask);
      }
    }
    prepareToUseHooksForComponent(prevThenableState, componentDebugInfo);
    if (supportsComponentStorage) {
      // Run the component in an Async Context that tracks the current owner.
      if (task.debugTask) {
        result = task.debugTask.run(
          // $FlowFixMe[method-unbinding]
          componentStorage.run.bind(
            componentStorage,
            componentDebugInfo,
            callComponentInDEV,
            Component,
            props,
            componentDebugInfo,
          ),
        );
      } else {
        result = componentStorage.run(
          componentDebugInfo,
          callComponentInDEV,
          Component,
          props,
          componentDebugInfo,
        );
      }
    } else {
      if (task.debugTask) {
        result = task.debugTask.run(
          callComponentInDEV.bind(null, Component, props, componentDebugInfo),
        );
      } else {
        result = callComponentInDEV(Component, props, componentDebugInfo);
      }
    }
  } else {
    componentDebugInfo = (null: any);
    prepareToUseHooksForComponent(prevThenableState, null);
    // The secondArg is always undefined in Server Components since refs error early.
    const secondArg = undefined;
    result = Component(props, secondArg);
  }

  if (request.status === ABORTING) {
    if (
      typeof result === 'object' &&
      result !== null &&
      typeof result.then === 'function' &&
      !isClientReference(result)
    ) {
      result.then(voidHandler, voidHandler);
    }
    // If we aborted during rendering we should interrupt the render but
    // we don't need to provide an error because the renderer will encode
    // the abort error as the reason.
    // eslint-disable-next-line no-throw-literal
    throw null;
  }

  if (__DEV__ || (enableProfilerTimer && enableAsyncDebugInfo)) {
    // Forward any debug information for any Promises that we use():ed during the render.
    // We do this at the end so that we don't keep doing this for each retry.
    const trackedThenables = getTrackedThenablesAfterRendering();
    if (trackedThenables !== null) {
      const stacks: Array<Error> =
        __DEV__ && enableAsyncDebugInfo
          ? (trackedThenables: any)._stacks ||
            ((trackedThenables: any)._stacks = [])
          : (null: any);
      for (let i = 0; i < trackedThenables.length; i++) {
        const stack = __DEV__ && enableAsyncDebugInfo ? stacks[i] : null;
        forwardDebugInfoFromThenable(
          request,
          task,
          trackedThenables[i],
          __DEV__ ? componentDebugInfo : null,
          stack,
        );
      }
    }
  }

  // Apply special cases.
  result = processServerComponentReturnValue(request, task, Component, result);

  if (__DEV__) {
    // From this point on, the parent is the component we just rendered until we
    // hit another JSX element.
    task.debugOwner = componentDebugInfo;
    // Unfortunately, we don't have a stack frame for this position. Conceptually
    // it would be the location of the `return` inside component that just rendered.
    task.debugStack = null;
    task.debugTask = null;
  }

  // Track this element's key on the Server Component on the keyPath context..
  const prevKeyPath = task.keyPath;
  const prevImplicitSlot = task.implicitSlot;
  if (key !== null) {
    // Append the key to the path. Technically a null key should really add the child
    // index. We don't do that to hold the payload small and implementation simple.
    task.keyPath = prevKeyPath === null ? key : prevKeyPath + ',' + key;
  } else if (prevKeyPath === null) {
    // This sequence of Server Components has no keys. This means that it was rendered
    // in a slot that needs to assign an implicit key. Even if children below have
    // explicit keys, they should not be used for the outer most key since it might
    // collide with other slots in that set.
    task.implicitSlot = true;
  }
  const json = renderModelDestructive(request, task, emptyRoot, '', result);
  task.keyPath = prevKeyPath;
  task.implicitSlot = prevImplicitSlot;
  return json;
}

function warnForMissingKey(
  request: Request,
  key: null | string,
  componentDebugInfo: ReactComponentInfo,
  debugTask: null | ConsoleTask,
): void {
  if (__DEV__) {
    let didWarnForKey = request.didWarnForKey;
    if (didWarnForKey == null) {
      didWarnForKey = request.didWarnForKey = new WeakSet();
    }
    const parentOwner = componentDebugInfo.owner;
    if (parentOwner != null) {
      if (didWarnForKey.has(parentOwner)) {
        // We already warned for other children in this parent.
        return;
      }
      didWarnForKey.add(parentOwner);
    }

    // Call with the server component as the currently rendering component
    // for context.
    const logKeyError = () => {
      console.error(
        'Each child in a list should have a unique "key" prop.' +
          '%s%s See https://react.dev/link/warning-keys for more information.',
        '',
        '',
      );
    };

    if (supportsComponentStorage) {
      // Run the component in an Async Context that tracks the current owner.
      if (debugTask) {
        debugTask.run(
          // $FlowFixMe[method-unbinding]
          componentStorage.run.bind(
            componentStorage,
            componentDebugInfo,
            callComponentInDEV,
            logKeyError,
            null,
            componentDebugInfo,
          ),
        );
      } else {
        componentStorage.run(
          componentDebugInfo,
          callComponentInDEV,
          logKeyError,
          null,
          componentDebugInfo,
        );
      }
    } else {
      if (debugTask) {
        debugTask.run(
          callComponentInDEV.bind(null, logKeyError, null, componentDebugInfo),
        );
      } else {
        callComponentInDEV(logKeyError, null, componentDebugInfo);
      }
    }
  }
}

function renderFragment(
  request: Request,
  task: Task,
  children: $ReadOnlyArray<ReactClientValue>,
): ReactJSONValue {
  if (__DEV__) {
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (
        child !== null &&
        typeof child === 'object' &&
        child.$$typeof === REACT_ELEMENT_TYPE
      ) {
        const element: ReactElement = (child: any);
        if (element.key === null && !element._store.validated) {
          element._store.validated = 2;
        }
      }
    }
  }

  if (task.keyPath !== null) {
    // We have a Server Component that specifies a key but we're now splitting
    // the tree using a fragment.
    const fragment = __DEV__
      ? [
          REACT_ELEMENT_TYPE,
          REACT_FRAGMENT_TYPE,
          task.keyPath,
          {children},
          null,
          null,
          0,
        ]
      : [REACT_ELEMENT_TYPE, REACT_FRAGMENT_TYPE, task.keyPath, {children}];
    if (!task.implicitSlot) {
      // If this was keyed inside a set. I.e. the outer Server Component was keyed
      // then we need to handle reorders of the whole set. To do this we need to wrap
      // this array in a keyed Fragment.
      return fragment;
    }
    // If the outer Server Component was implicit but then an inner one had a key
    // we don't actually need to be able to move the whole set around. It'll always be
    // in an implicit slot. The key only exists to be able to reset the state of the
    // children. We could achieve the same effect by passing on the keyPath to the next
    // set of components inside the fragment. This would also allow a keyless fragment
    // reconcile against a single child.
    // Unfortunately because of JSON.stringify, we can't call the recursive loop for
    // each child within this context because we can't return a set with already resolved
    // values. E.g. a string would get double encoded. Returning would pop the context.
    // So instead, we wrap it with an unkeyed fragment and inner keyed fragment.
    return [fragment];
  }
  // Since we're yielding here, that implicitly resets the keyPath context on the
  // way up. Which is what we want since we've consumed it. If this changes to
  // be recursive serialization, we need to reset the keyPath and implicitSlot,
  // before recursing here.
  if (__DEV__) {
    const debugInfo: ?ReactDebugInfo = (children: any)._debugInfo;
    if (debugInfo) {
      // If this came from Flight, forward any debug info into this new row.
      if (!canEmitDebugInfo) {
        // We don't have a chunk to assign debug info. We need to outline this
        // component to assign it an ID.
        return outlineTask(request, task);
      } else {
        // Forward any debug info we have the first time we see it.
        // We do this after init so that we have received all the debug info
        // from the server by the time we emit it.
        forwardDebugInfo(request, task, debugInfo);
      }
      // Since we're rendering this array again, create a copy that doesn't
      // have the debug info so we avoid outlining or emitting debug info again.
      children = Array.from(children);
    }
  }
  return children;
}

function renderAsyncFragment(
  request: Request,
  task: Task,
  children: $AsyncIterable<ReactClientValue, ReactClientValue, void>,
  getAsyncIterator: () => $AsyncIterator<any, any, any>,
): ReactJSONValue {
  if (task.keyPath !== null) {
    // We have a Server Component that specifies a key but we're now splitting
    // the tree using a fragment.
    const fragment = __DEV__
      ? [
          REACT_ELEMENT_TYPE,
          REACT_FRAGMENT_TYPE,
          task.keyPath,
          {children},
          null,
          null,
          0,
        ]
      : [REACT_ELEMENT_TYPE, REACT_FRAGMENT_TYPE, task.keyPath, {children}];
    if (!task.implicitSlot) {
      // If this was keyed inside a set. I.e. the outer Server Component was keyed
      // then we need to handle reorders of the whole set. To do this we need to wrap
      // this array in a keyed Fragment.
      return fragment;
    }
    // If the outer Server Component was implicit but then an inner one had a key
    // we don't actually need to be able to move the whole set around. It'll always be
    // in an implicit slot. The key only exists to be able to reset the state of the
    // children. We could achieve the same effect by passing on the keyPath to the next
    // set of components inside the fragment. This would also allow a keyless fragment
    // reconcile against a single child.
    // Unfortunately because of JSON.stringify, we can't call the recursive loop for
    // each child within this context because we can't return a set with already resolved
    // values. E.g. a string would get double encoded. Returning would pop the context.
    // So instead, we wrap it with an unkeyed fragment and inner keyed fragment.
    return [fragment];
  }

  // Since we're yielding here, that implicitly resets the keyPath context on the
  // way up. Which is what we want since we've consumed it. If this changes to
  // be recursive serialization, we need to reset the keyPath and implicitSlot,
  // before recursing here.
  const asyncIterator = getAsyncIterator.call(children);
  return serializeAsyncIterable(request, task, children, asyncIterator);
}

function renderClientElement(
  request: Request,
  task: Task,
  type: any,
  key: null | string,
  props: any,
  validated: number, // DEV-only
): ReactJSONValue {
  // We prepend the terminal client element that actually gets serialized with
  // the keys of any Server Components which are not serialized.
  const keyPath = task.keyPath;
  if (key === null) {
    key = keyPath;
  } else if (keyPath !== null) {
    key = keyPath + ',' + key;
  }
  let debugOwner = null;
  let debugStack = null;
  if (__DEV__) {
    debugOwner = task.debugOwner;
    if (debugOwner !== null) {
      // Ensure we outline this owner if it is the first time we see it.
      // So that we can refer to it directly.
      outlineComponentInfo(request, debugOwner);
    }
    if (task.debugStack !== null) {
      // Outline the debug stack so that we write to the completedDebugChunks instead.
      debugStack = filterStackTrace(
        request,
        parseStackTrace(task.debugStack, 1),
      );
      const id = outlineDebugModel(
        request,
        {objectLimit: debugStack.length * 2 + 1},
        debugStack,
      );
      // We also store this in the main dedupe set so that it can be referenced by inline React Elements.
      request.writtenObjects.set(debugStack, serializeByValueID(id));
    }
  }
  const element = __DEV__
    ? [REACT_ELEMENT_TYPE, type, key, props, debugOwner, debugStack, validated]
    : [REACT_ELEMENT_TYPE, type, key, props];
  if (task.implicitSlot && key !== null) {
    // The root Server Component had no key so it was in an implicit slot.
    // If we had a key lower, it would end up in that slot with an explicit key.
    // We wrap the element in a fragment to give it an implicit key slot with
    // an inner explicit key.
    return [element];
  }
  // Since we're yielding here, that implicitly resets the keyPath context on the
  // way up. Which is what we want since we've consumed it. If this changes to
  // be recursive serialization, we need to reset the keyPath and implicitSlot,
  // before recursing here. We also need to reset it once we render into an array
  // or anything else too which we also get implicitly.
  return element;
}

// Determines if we're currently rendering at the top level of a task and therefore
// is safe to emit debug info associated with that task. Otherwise, if we're in
// a nested context, we need to first outline.
let canEmitDebugInfo: boolean = false;

// Approximate string length of the currently serializing row.
// Used to power outlining heuristics.
let serializedSize = 0;
const MAX_ROW_SIZE = 3200;

function deferTask(request: Request, task: Task): ReactJSONValue {
  // Like outlineTask but instead the item is scheduled to be serialized
  // after its parent in the stream.
  const newTask = createTask(
    request,
    task.model, // the currently rendering element
    task.keyPath, // unlike outlineModel this one carries along context
    task.implicitSlot,
    request.abortableTasks,
    enableProfilerTimer &&
      (enableComponentPerformanceTrack || enableAsyncDebugInfo)
      ? task.time
      : 0,
    __DEV__ ? task.debugOwner : null,
    __DEV__ ? task.debugStack : null,
    __DEV__ ? task.debugTask : null,
  );

  pingTask(request, newTask);
  return serializeLazyID(newTask.id);
}

function outlineTask(request: Request, task: Task): ReactJSONValue {
  const newTask = createTask(
    request,
    task.model, // the currently rendering element
    task.keyPath, // unlike outlineModel this one carries along context
    task.implicitSlot,
    request.abortableTasks,
    enableProfilerTimer &&
      (enableComponentPerformanceTrack || enableAsyncDebugInfo)
      ? task.time
      : 0,
    __DEV__ ? task.debugOwner : null,
    __DEV__ ? task.debugStack : null,
    __DEV__ ? task.debugTask : null,
  );

  retryTask(request, newTask);
  if (newTask.status === COMPLETED) {
    // We completed synchronously so we can refer to this by reference. This
    // makes it behaves the same as prod during deserialization.
    return serializeByValueID(newTask.id);
  }
  // This didn't complete synchronously so it wouldn't have even if we didn't
  // outline it, so this would reduce to a lazy reference even in prod.
  return serializeLazyID(newTask.id);
}

function outlineHaltedTask(
  request: Request,
  task: Task,
  allowLazy: boolean,
): ReactJSONValue {
  // In the future if we track task state for resuming we'll maybe need to
  // construnct an actual task here but since we're never going to retry it
  // we just claim the id and serialize it according to the proper convention
  const taskId = request.nextChunkId++;
  if (allowLazy) {
    // We're halting in a position that can handle a lazy reference
    return serializeLazyID(taskId);
  } else {
    // We're halting in a position that needs a value reference
    return serializeByValueID(taskId);
  }
}

function renderElement(
  request: Request,
  task: Task,
  type: any,
  key: null | string,
  ref: mixed,
  props: any,
  validated: number, // DEV only
): ReactJSONValue {
  if (ref !== null && ref !== undefined) {
    // When the ref moves to the regular props object this will implicitly
    // throw for functions. We could probably relax it to a DEV warning for other
    // cases.
    // TODO: `ref` is now just a prop when `enableRefAsProp` is on. Should we
    // do what the above comment says?
    throw new Error(
      'Refs cannot be used in Server Components, nor passed to Client Components.',
    );
  }
  if (__DEV__) {
    jsxPropsParents.set(props, type);
    if (typeof props.children === 'object' && props.children !== null) {
      jsxChildrenParents.set(props.children, type);
    }
  }
  if (
    typeof type === 'function' &&
    !isClientReference(type) &&
    !isOpaqueTemporaryReference(type)
  ) {
    // This is a Server Component.
    return renderFunctionComponent(request, task, key, type, props, validated);
  } else if (type === REACT_FRAGMENT_TYPE && key === null) {
    // For key-less fragments, we add a small optimization to avoid serializing
    // it as a wrapper.
    if (__DEV__ && validated === 2) {
      // Create a fake owner node for the error stack.
      const componentDebugInfo: ReactComponentInfo = {
        name: 'Fragment',
        env: (0, request.environmentName)(),
        key: key,
        owner: task.debugOwner,
        stack:
          task.debugStack === null
            ? null
            : filterStackTrace(request, parseStackTrace(task.debugStack, 1)),
        props: props,
        debugStack: task.debugStack,
        debugTask: task.debugTask,
      };
      warnForMissingKey(request, key, componentDebugInfo, task.debugTask);
    }
    const prevImplicitSlot = task.implicitSlot;
    if (task.keyPath === null) {
      task.implicitSlot = true;
    }
    const json = renderModelDestructive(
      request,
      task,
      emptyRoot,
      '',
      props.children,
    );
    task.implicitSlot = prevImplicitSlot;
    return json;
  } else if (
    type != null &&
    typeof type === 'object' &&
    !isClientReference(type)
  ) {
    switch (type.$$typeof) {
      case REACT_LAZY_TYPE: {
        let wrappedType;
        if (__DEV__) {
          wrappedType = callLazyInitInDEV(type);
        } else {
          const payload = type._payload;
          const init = type._init;
          wrappedType = init(payload);
        }
        if (request.status === ABORTING) {
          // lazy initializers are user code and could abort during render
          // we don't wan to return any value resolved from the lazy initializer
          // if it aborts so we interrupt rendering here
          // eslint-disable-next-line no-throw-literal
          throw null;
        }
        return renderElement(
          request,
          task,
          wrappedType,
          key,
          ref,
          props,
          validated,
        );
      }
      case REACT_FORWARD_REF_TYPE: {
        return renderFunctionComponent(
          request,
          task,
          key,
          type.render,
          props,
          validated,
        );
      }
      case REACT_MEMO_TYPE: {
        return renderElement(
          request,
          task,
          type.type,
          key,
          ref,
          props,
          validated,
        );
      }
      case REACT_ELEMENT_TYPE: {
        // This is invalid but we'll let the client determine that it is.
        if (__DEV__) {
          // Disable the key warning that would happen otherwise because this
          // element gets serialized inside an array. We'll error later anyway.
          type._store.validated = 1;
        }
      }
    }
  }
  // For anything else, try it on the client instead.
  // We don't know if the client will support it or not. This might error on the
  // client or error during serialization but the stack will point back to the
  // server.
  return renderClientElement(request, task, type, key, props, validated);
}

function visitAsyncNode(
  request: Request,
  task: Task,
  node: AsyncSequence,
  visited: Set<AsyncSequence | ReactDebugInfo>,
  cutOff: number,
): void | null | PromiseNode | IONode {
  if (visited.has(node)) {
    // It's possible to visit them same node twice when it's part of both an "awaited" path
    // and a "previous" path. This also gracefully handles cycles which would be a bug.
    return null;
  }
  visited.add(node);
  let previousIONode = null;
  // First visit anything that blocked this sequence to start in the first place.
  if (node.previous !== null && node.end > request.timeOrigin) {
    previousIONode = visitAsyncNode(
      request,
      task,
      node.previous,
      visited,
      cutOff,
    );
    if (previousIONode === undefined) {
      // Undefined is used as a signal that we found a suitable aborted node and we don't have to find
      // further aborted nodes.
      return undefined;
    }
  }
  switch (node.tag) {
    case IO_NODE: {
      return node;
    }
    case UNRESOLVED_PROMISE_NODE: {
      return previousIONode;
    }
    case PROMISE_NODE: {
      if (node.end <= request.timeOrigin) {
        // This was already resolved when we started this render. It must have been either something
        // that's part of a start up sequence or externally cached data. We exclude that information.
        // The technique for debugging the effects of uncached data on the render is to simply uncache it.
        return previousIONode;
      }
      const awaited = node.awaited;
      let match: void | null | PromiseNode | IONode = previousIONode;
      if (awaited !== null) {
        const ioNode = visitAsyncNode(request, task, awaited, visited, cutOff);
        if (ioNode === undefined) {
          // Undefined is used as a signal that we found a suitable aborted node and we don't have to find
          // further aborted nodes.
          return undefined;
        } else if (ioNode !== null) {
          // This Promise was blocked on I/O. That's a signal that this Promise is interesting to log.
          // We don't log it yet though. We return it to be logged by the point where it's awaited.
          // The ioNode might be another PromiseNode in the case where none of the AwaitNode had
          // unfiltered stacks.
          if (ioNode.tag === PROMISE_NODE) {
            // If the ioNode was a Promise, then that means we found one in user space since otherwise
            // we would've returned an IO node. We assume this has the best stack.
            match = ioNode;
          } else if (
            node.stack === null ||
            !hasUnfilteredFrame(request, node.stack)
          ) {
            // If this Promise was created inside only third party code, then try to use
            // the inner I/O node instead. This could happen if third party calls into first
            // party to perform some I/O.
            match = ioNode;
          } else {
            match = node;
          }
        } else if (request.status === ABORTING) {
          if (node.start < request.abortTime && node.end > request.abortTime) {
            // We aborted this render. If this Promise spanned the abort time it was probably the
            // Promise that was aborted. This won't necessarily have I/O associated with it but
            // it's a point of interest.
            if (
              node.stack !== null &&
              hasUnfilteredFrame(request, node.stack)
            ) {
              match = node;
            }
          }
        }
      }
      // We need to forward after we visit awaited nodes because what ever I/O we requested that's
      // the thing that generated this node and its virtual children.
      const promise = node.promise.deref();
      if (promise !== undefined) {
        const debugInfo = promise._debugInfo;
        if (debugInfo != null && !visited.has(debugInfo)) {
          visited.add(debugInfo);
          forwardDebugInfo(request, task, debugInfo);
        }
      }
      return match;
    }
    case UNRESOLVED_AWAIT_NODE: {
      return previousIONode;
    }
    case AWAIT_NODE: {
      const awaited = node.awaited;
      let match: void | null | PromiseNode | IONode = previousIONode;
      if (awaited !== null) {
        const ioNode = visitAsyncNode(request, task, awaited, visited, cutOff);
        if (ioNode === undefined) {
          // Undefined is used as a signal that we found a suitable aborted node and we don't have to find
          // further aborted nodes.
          return undefined;
        } else if (ioNode !== null) {
          const startTime: number = node.start;
          const endTime: number = node.end;
          if (endTime <= request.timeOrigin) {
            // This was already resolved when we started this render. It must have been either something
            // that's part of a start up sequence or externally cached data. We exclude that information.
            return null;
          } else if (startTime < cutOff) {
            // We started awaiting this node before we started rendering this sequence.
            // This means that this particular await was never part of the current sequence.
            // If we have another await higher up in the chain it might have a more actionable stack
            // from the perspective of this component. If we end up here from the "previous" path,
            // then this gets I/O ignored, which is what we want because it means it was likely
            // just part of a previous component's rendering.
            match = ioNode;
            if (
              node.stack !== null &&
              isAwaitInUserspace(request, node.stack)
            ) {
              // This await happened earlier but it was done in user space. This is the first time
              // that user space saw the value of the I/O. We know we'll emit the I/O eventually
              // but if we do it now we can override the promise value of the I/O entry to the
              // one observed by this await which will be a better value than the internals of
              // the I/O entry. If it's still alive that is.
              const promise =
                awaited.promise === null ? undefined : awaited.promise.deref();
              if (promise !== undefined) {
                serializeIONode(request, ioNode, awaited.promise);
              }
            }
          } else {
            if (
              node.stack === null ||
              !isAwaitInUserspace(request, node.stack)
            ) {
              // If this await was fully filtered out, then it was inside third party code
              // such as in an external library. We return the I/O node and try another await.
              match = ioNode;
            } else if (
              request.status === ABORTING &&
              startTime > request.abortTime
            ) {
              // This was awaited after aborting so we skip it.
            } else {
              // We found a user space await.

              // Outline the IO node.
              // The ioNode is where the I/O was initiated, but after that it could have been
              // processed through various awaits in the internals of the third party code.
              // Therefore we don't use the inner most Promise as the conceptual value but the
              // Promise that was ultimately awaited by the user space await.
              serializeIONode(request, ioNode, awaited.promise);

              // We log the environment at the time when the last promise pigned ping which may
              // be later than what the environment was when we actually started awaiting.
              const env = (0, request.environmentName)();
              advanceTaskTime(request, task, startTime);
              // Then emit a reference to us awaiting it in the current task.
              request.pendingChunks++;
              emitDebugChunk(request, task.id, {
                awaited: ((ioNode: any): ReactIOInfo), // This is deduped by this reference.
                env: env,
                owner: node.owner,
                stack:
                  node.stack === null
                    ? null
                    : filterStackTrace(request, node.stack),
              });
              // Mark the end time of the await. If we're aborting then we don't emit this
              // to signal that this never resolved inside this render.
              markOperationEndTime(request, task, endTime);
              if (request.status === ABORTING) {
                // Undefined is used as a signal that we found a suitable aborted node and we don't have to find
                // further aborted nodes.
                match = undefined;
              }
            }
          }
        }
      }
      // We need to forward after we visit awaited nodes because what ever I/O we requested that's
      // the thing that generated this node and its virtual children.
      const promise = node.promise.deref();
      if (promise !== undefined) {
        const debugInfo = promise._debugInfo;
        if (debugInfo != null && !visited.has(debugInfo)) {
          visited.add(debugInfo);
          forwardDebugInfo(request, task, debugInfo);
        }
      }
      return match;
    }
    default: {
      // eslint-disable-next-line react-internal/prod-error-codes
      throw new Error('Unknown AsyncSequence tag. This is a bug in React.');
    }
  }
}

function emitAsyncSequence(
  request: Request,
  task: Task,
  node: AsyncSequence,
  alreadyForwardedDebugInfo: ?ReactDebugInfo,
  owner: null | ReactComponentInfo,
  stack: null | Error,
): void {
  const visited: Set<AsyncSequence | ReactDebugInfo> = new Set();
  if (__DEV__ && alreadyForwardedDebugInfo) {
    visited.add(alreadyForwardedDebugInfo);
  }
  const awaitedNode = visitAsyncNode(request, task, node, visited, task.time);
  if (awaitedNode === undefined) {
    // Undefined is used as a signal that we found an aborted await and that's good enough
    // anything derived from that aborted node might be irrelevant.
  } else if (awaitedNode !== null) {
    // Nothing in user space (unfiltered stack) awaited this.
    serializeIONode(request, awaitedNode, awaitedNode.promise);
    request.pendingChunks++;
    // We log the environment at the time when we ping which may be later than what the
    // environment was when we actually started awaiting.
    const env = (0, request.environmentName)();
    // If we don't have any thing awaited, the time we started awaiting was internal
    // when we yielded after rendering. The current task time is basically that.
    const debugInfo: ReactAsyncInfo = {
      awaited: ((awaitedNode: any): ReactIOInfo), // This is deduped by this reference.
      env: env,
    };
    if (__DEV__) {
      if (owner === null && stack === null) {
        // We have no location for the await. We can use the JSX callsite of the parent
        // as the await if this was just passed as a prop.
        if (task.debugOwner !== null) {
          // $FlowFixMe[cannot-write]
          debugInfo.owner = task.debugOwner;
        }
        if (task.debugStack !== null) {
          // $FlowFixMe[cannot-write]
          debugInfo.stack = filterStackTrace(
            request,
            parseStackTrace(task.debugStack, 1),
          );
        }
      } else {
        if (owner != null) {
          // $FlowFixMe[cannot-write]
          debugInfo.owner = owner;
        }
        if (stack != null) {
          // $FlowFixMe[cannot-write]
          debugInfo.stack = filterStackTrace(
            request,
            parseStackTrace(stack, 1),
          );
        }
      }
    }
    // We don't have a start time for this await but in case there was no start time emitted
    // we need to include something. TODO: We should maybe ideally track the time when we
    // called .then() but without updating the task.time field since that's used for the cutoff.
    advanceTaskTime(request, task, task.time);
    emitDebugChunk(request, task.id, debugInfo);
    // Mark the end time of the await. If we're aborting then we don't emit this
    // to signal that this never resolved inside this render.
    // If we're currently aborting, then this never resolved into user space.
    markOperationEndTime(request, task, awaitedNode.end);
  }
}

function pingTask(request: Request, task: Task): void {
  if (
    enableProfilerTimer &&
    (enableComponentPerformanceTrack || enableAsyncDebugInfo)
  ) {
    // If this was async we need to emit the time when it completes.
    task.timed = true;
  }
  const pingedTasks = request.pingedTasks;
  pingedTasks.push(task);
  if (pingedTasks.length === 1) {
    request.flushScheduled = request.destination !== null;
    if (request.type === PRERENDER || request.status === OPENING) {
      scheduleMicrotask(() => performWork(request));
    } else {
      scheduleWork(() => performWork(request));
    }
  }
}

function createTask(
  request: Request,
  model: ReactClientValue,
  keyPath: null | string,
  implicitSlot: boolean,
  abortSet: Set<Task>,
  lastTimestamp: number, // Profiling-only
  debugOwner: null | ReactComponentInfo, // DEV-only
  debugStack: null | Error, // DEV-only
  debugTask: null | ConsoleTask, // DEV-only
): Task {
  request.pendingChunks++;
  const id = request.nextChunkId++;
  if (typeof model === 'object' && model !== null) {
    // If we're about to write this into a new task we can assign it an ID early so that
    // any other references can refer to the value we're about to write.
    if (keyPath !== null || implicitSlot) {
      // If we're in some kind of context we can't necessarily reuse this object depending
      // what parent components are used.
    } else {
      request.writtenObjects.set(model, serializeByValueID(id));
    }
  }
  const task: Task = (({
    id,
    status: PENDING,
    model,
    keyPath,
    implicitSlot,
    ping: () => pingTask(request, task),
    toJSON: function (
      this:
        | {+[key: string | number]: ReactClientValue}
        | $ReadOnlyArray<ReactClientValue>,
      parentPropertyName: string,
      value: ReactClientValue,
    ): ReactJSONValue {
      const parent = this;
      // Make sure that `parent[parentPropertyName]` wasn't JSONified before `value` was passed to us
      if (__DEV__) {
        // $FlowFixMe[incompatible-use]
        const originalValue = parent[parentPropertyName];
        if (
          typeof originalValue === 'object' &&
          originalValue !== value &&
          !(originalValue instanceof Date)
        ) {
          // Call with the server component as the currently rendering component
          // for context.
          callWithDebugContextInDEV(request, task, () => {
            if (objectName(originalValue) !== 'Object') {
              const jsxParentType = jsxChildrenParents.get(parent);
              if (typeof jsxParentType === 'string') {
                console.error(
                  '%s objects cannot be rendered as text children. Try formatting it using toString().%s',
                  objectName(originalValue),
                  describeObjectForErrorMessage(parent, parentPropertyName),
                );
              } else {
                console.error(
                  'Only plain objects can be passed to Client Components from Server Components. ' +
                    '%s objects are not supported.%s',
                  objectName(originalValue),
                  describeObjectForErrorMessage(parent, parentPropertyName),
                );
              }
            } else {
              console.error(
                'Only plain objects can be passed to Client Components from Server Components. ' +
                  'Objects with toJSON methods are not supported. Convert it manually ' +
                  'to a simple value before passing it to props.%s',
                describeObjectForErrorMessage(parent, parentPropertyName),
              );
            }
          });
        }
      }
      return renderModel(request, task, parent, parentPropertyName, value);
    },
    thenableState: null,
  }: Omit<
    Task,
    | 'timed'
    | 'time'
    | 'environmentName'
    | 'debugOwner'
    | 'debugStack'
    | 'debugTask',
  >): any);
  if (
    enableProfilerTimer &&
    (enableComponentPerformanceTrack || enableAsyncDebugInfo)
  ) {
    task.timed = false;
    task.time = lastTimestamp;
  }
  if (__DEV__) {
    task.environmentName = request.environmentName();
    task.debugOwner = debugOwner;
    task.debugStack = debugStack;
    task.debugTask = debugTask;
  }
  abortSet.add(task);
  return task;
}

function serializeByValueID(id: number): string {
  return '$' + id.toString(16);
}

function serializeLazyID(id: number): string {
  return '$L' + id.toString(16);
}

function serializePromiseID(id: number): string {
  return '$@' + id.toString(16);
}

function serializeServerReferenceID(id: number): string {
  return '$F' + id.toString(16);
}

function serializeSymbolReference(name: string): string {
  return '$S' + name;
}

function serializeDeferredObject(
  request: Request,
  value: ReactClientReference | string,
): string {
  const deferredDebugObjects = request.deferredDebugObjects;
  if (deferredDebugObjects !== null) {
    // This client supports a long lived connection. We can assign this object
    // an ID to be lazy loaded later.
    // This keeps the connection alive until we ask for it or release it.
    request.pendingDebugChunks++;
    const id = request.nextChunkId++;
    deferredDebugObjects.existing.set(value, id);
    deferredDebugObjects.retained.set(id, value);
    return '$Y' + id.toString(16);
  }
  return '$Y';
}

function serializeNumber(number: number): string | number {
  if (Number.isFinite(number)) {
    if (number === 0 && 1 / number === -Infinity) {
      return '$-0';
    } else {
      return number;
    }
  } else {
    if (number === Infinity) {
      return '$Infinity';
    } else if (number === -Infinity) {
      return '$-Infinity';
    } else {
      return '$NaN';
    }
  }
}

function serializeUndefined(): string {
  return '$undefined';
}

function serializeDate(date: Date): string {
  // JSON.stringify automatically calls Date.prototype.toJSON which calls toISOString.
  // We need only tack on a $D prefix.
  return '$D' + date.toJSON();
}

function serializeDateFromDateJSON(dateJSON: string): string {
  // JSON.stringify automatically calls Date.prototype.toJSON which calls toISOString.
  // We need only tack on a $D prefix.
  return '$D' + dateJSON;
}

function serializeBigInt(n: bigint): string {
  return '$n' + n.toString(10);
}

function serializeRowHeader(tag: string, id: number) {
  return id.toString(16) + ':' + tag;
}

function encodeReferenceChunk(
  request: Request,
  id: number,
  reference: string,
): Chunk {
  const json = stringify(reference);
  const row = id.toString(16) + ':' + json + '\n';
  return stringToChunk(row);
}

function serializeClientReference(
  request: Request,
  parent:
    | {+[propertyName: string | number]: ReactClientValue}
    | $ReadOnlyArray<ReactClientValue>,
  parentPropertyName: string,
  clientReference: ClientReference<any>,
): string {
  const clientReferenceKey: ClientReferenceKey =
    getClientReferenceKey(clientReference);
  const writtenClientReferences = request.writtenClientReferences;
  const existingId = writtenClientReferences.get(clientReferenceKey);
  if (existingId !== undefined) {
    if (parent[0] === REACT_ELEMENT_TYPE && parentPropertyName === '1') {
      // If we're encoding the "type" of an element, we can refer
      // to that by a lazy reference instead of directly since React
      // knows how to deal with lazy values. This lets us suspend
      // on this component rather than its parent until the code has
      // loaded.
      return serializeLazyID(existingId);
    }
    return serializeByValueID(existingId);
  }
  try {
    const clientReferenceMetadata: ClientReferenceMetadata =
      resolveClientReferenceMetadata(request.bundlerConfig, clientReference);
    request.pendingChunks++;
    const importId = request.nextChunkId++;
    emitImportChunk(request, importId, clientReferenceMetadata, false);
    writtenClientReferences.set(clientReferenceKey, importId);
    if (parent[0] === REACT_ELEMENT_TYPE && parentPropertyName === '1') {
      // If we're encoding the "type" of an element, we can refer
      // to that by a lazy reference instead of directly since React
      // knows how to deal with lazy values. This lets us suspend
      // on this component rather than its parent until the code has
      // loaded.
      return serializeLazyID(importId);
    }
    return serializeByValueID(importId);
  } catch (x) {
    request.pendingChunks++;
    const errorId = request.nextChunkId++;
    const digest = logRecoverableError(request, x, null);
    emitErrorChunk(request, errorId, digest, x, false);
    return serializeByValueID(errorId);
  }
}

function serializeDebugClientReference(
  request: Request,
  parent:
    | {+[propertyName: string | number]: ReactClientValue}
    | $ReadOnlyArray<ReactClientValue>,
  parentPropertyName: string,
  clientReference: ClientReference<any>,
): string {
  // Like serializeDebugClientReference but it doesn't dedupe in the regular set
  // and it writes to completedDebugChunk instead of imports.
  const clientReferenceKey: ClientReferenceKey =
    getClientReferenceKey(clientReference);
  const writtenClientReferences = request.writtenClientReferences;
  const existingId = writtenClientReferences.get(clientReferenceKey);
  if (existingId !== undefined) {
    if (parent[0] === REACT_ELEMENT_TYPE && parentPropertyName === '1') {
      // If we're encoding the "type" of an element, we can refer
      // to that by a lazy reference instead of directly since React
      // knows how to deal with lazy values. This lets us suspend
      // on this component rather than its parent until the code has
      // loaded.
      return serializeLazyID(existingId);
    }
    return serializeByValueID(existingId);
  }
  try {
    const clientReferenceMetadata: ClientReferenceMetadata =
      resolveClientReferenceMetadata(request.bundlerConfig, clientReference);
    request.pendingDebugChunks++;
    const importId = request.nextChunkId++;
    emitImportChunk(request, importId, clientReferenceMetadata, true);
    if (parent[0] === REACT_ELEMENT_TYPE && parentPropertyName === '1') {
      // If we're encoding the "type" of an element, we can refer
      // to that by a lazy reference instead of directly since React
      // knows how to deal with lazy values. This lets us suspend
      // on this component rather than its parent until the code has
      // loaded.
      return serializeLazyID(importId);
    }
    return serializeByValueID(importId);
  } catch (x) {
    request.pendingDebugChunks++;
    const errorId = request.nextChunkId++;
    const digest = logRecoverableError(request, x, null);
    emitErrorChunk(request, errorId, digest, x, true);
    return serializeByValueID(errorId);
  }
}

function outlineModel(request: Request, value: ReactClientValue): number {
  const newTask = createTask(
    request,
    value,
    null, // The way we use outlining is for reusing an object.
    false, // It makes no sense for that use case to be contextual.
    request.abortableTasks,
    enableProfilerTimer &&
      (enableComponentPerformanceTrack || enableAsyncDebugInfo)
      ? performance.now() // TODO: This should really inherit the time from the task.
      : 0,
    null, // TODO: Currently we don't associate any debug information with
    null, // this object on the server. If it ends up erroring, it won't
    null, // have any context on the server but can on the client.
  );
  retryTask(request, newTask);
  return newTask.id;
}

function serializeServerReference(
  request: Request,
  serverReference: ServerReference<any>,
): string {
  const writtenServerReferences = request.writtenServerReferences;
  const existingId = writtenServerReferences.get(serverReference);
  if (existingId !== undefined) {
    return serializeServerReferenceID(existingId);
  }

  const boundArgs: null | Array<any> = getServerReferenceBoundArguments(
    request.bundlerConfig,
    serverReference,
  );
  const bound = boundArgs === null ? null : Promise.resolve(boundArgs);
  const id = getServerReferenceId(request.bundlerConfig, serverReference);

  let location: null | ReactFunctionLocation = null;
  if (__DEV__) {
    const error = getServerReferenceLocation(
      request.bundlerConfig,
      serverReference,
    );
    if (error) {
      const frames = parseStackTrace(error, 1);
      if (frames.length > 0) {
        const firstFrame = frames[0];
        location = [
          firstFrame[0],
          firstFrame[1],
          firstFrame[2], // The line and col of the callsite represents the
          firstFrame[3], // enclosing line and col of the function.
        ];
      }
    }
  }

  const serverReferenceMetadata: {
    id: ServerReferenceId,
    bound: null | Promise<Array<any>>,
    name?: string, // DEV-only
    env?: string, // DEV-only
    location?: ReactFunctionLocation, // DEV-only
  } =
    __DEV__ && location !== null
      ? {
          id,
          bound,
          name:
            typeof serverReference === 'function' ? serverReference.name : '',
          env: (0, request.environmentName)(),
          location,
        }
      : {
          id,
          bound,
        };
  const metadataId = outlineModel(request, serverReferenceMetadata);
  writtenServerReferences.set(serverReference, metadataId);
  return serializeServerReferenceID(metadataId);
}

function serializeTemporaryReference(
  request: Request,
  reference: string,
): string {
  return '$T' + reference;
}

function serializeLargeTextString(request: Request, text: string): string {
  request.pendingChunks++;
  const textId = request.nextChunkId++;
  emitTextChunk(request, textId, text, false);
  return serializeByValueID(textId);
}

function serializeDebugLargeTextString(request: Request, text: string): string {
  request.pendingDebugChunks++;
  const textId = request.nextChunkId++;
  emitTextChunk(request, textId, text, true);
  return serializeByValueID(textId);
}

function serializeMap(
  request: Request,
  map: Map<ReactClientValue, ReactClientValue>,
): string {
  const entries = Array.from(map);
  const id = outlineModel(request, entries);
  return '$Q' + id.toString(16);
}

function serializeFormData(request: Request, formData: FormData): string {
  const entries = Array.from(formData.entries());
  const id = outlineModel(request, (entries: any));
  return '$K' + id.toString(16);
}

function serializeDebugFormData(request: Request, formData: FormData): string {
  const entries = Array.from(formData.entries());
  const id = outlineDebugModel(
    request,
    {objectLimit: entries.length * 2 + 1},
    (entries: any),
  );
  return '$K' + id.toString(16);
}

function serializeSet(request: Request, set: Set<ReactClientValue>): string {
  const entries = Array.from(set);
  const id = outlineModel(request, entries);
  return '$W' + id.toString(16);
}

function serializeDebugMap(
  request: Request,
  counter: {objectLimit: number},
  map: Map<ReactClientValue, ReactClientValue>,
): string {
  // Like serializeMap but for renderDebugModel.
  const entries = Array.from(map);
  // The Map itself doesn't take up any space but the outlined object does.
  counter.objectLimit++;
  for (let i = 0; i < entries.length; i++) {
    // Outline every object entry in case we run out of space to serialize them.
    // Because we can't mark these values as limited.
    const entry = entries[i];
    doNotLimit.add(entry);
    const key = entry[0];
    const value = entry[1];
    if (typeof key === 'object' && key !== null) {
      doNotLimit.add(key);
    }
    if (typeof value === 'object' && value !== null) {
      doNotLimit.add(value);
    }
  }
  const id = outlineDebugModel(request, counter, entries);
  return '$Q' + id.toString(16);
}

function serializeDebugSet(
  request: Request,
  counter: {objectLimit: number},
  set: Set<ReactClientValue>,
): string {
  // Like serializeMap but for renderDebugModel.
  const entries = Array.from(set);
  // The Set itself doesn't take up any space but the outlined object does.
  counter.objectLimit++;
  for (let i = 0; i < entries.length; i++) {
    // Outline every object entry in case we run out of space to serialize them.
    // Because we can't mark these values as limited.
    const entry = entries[i];
    if (typeof entry === 'object' && entry !== null) {
      doNotLimit.add(entry);
    }
  }
  const id = outlineDebugModel(request, counter, entries);
  return '$W' + id.toString(16);
}

function serializeIterator(
  request: Request,
  iterator: Iterator<ReactClientValue>,
): string {
  const id = outlineModel(request, Array.from(iterator));
  return '$i' + id.toString(16);
}

function serializeTypedArray(
  request: Request,
  tag: string,
  typedArray: $ArrayBufferView,
): string {
  request.pendingChunks++;
  const bufferId = request.nextChunkId++;
  emitTypedArrayChunk(request, bufferId, tag, typedArray, false);
  return serializeByValueID(bufferId);
}

function serializeDebugTypedArray(
  request: Request,
  tag: string,
  typedArray: $ArrayBufferView,
): string {
  request.pendingDebugChunks++;
  const bufferId = request.nextChunkId++;
  emitTypedArrayChunk(request, bufferId, tag, typedArray, true);
  return serializeByValueID(bufferId);
}

function serializeDebugBlob(request: Request, blob: Blob): string {
  const model: Array<string | Uint8Array> = [blob.type];
  const reader = blob.stream().getReader();
  request.pendingDebugChunks++;
  const id = request.nextChunkId++;
  function progress(
    entry: {done: false, value: Uint8Array} | {done: true, value: void},
  ): Promise<void> | void {
    if (entry.done) {
      emitOutlinedDebugModelChunk(
        request,
        id,
        {objectLimit: model.length + 2},
        model,
      );
      enqueueFlush(request);
      return;
    }
    // TODO: Emit the chunk early and refer to it later by dedupe.
    model.push(entry.value);
    // $FlowFixMe[incompatible-call]
    return reader.read().then(progress).catch(error);
  }
  function error(reason: mixed) {
    const digest = '';
    emitErrorChunk(request, id, digest, reason, true);
    enqueueFlush(request);
    // $FlowFixMe should be able to pass mixed
    reader.cancel(reason).then(noop, noop);
  }
  // $FlowFixMe[incompatible-call]
  reader.read().then(progress).catch(error);
  return '$B' + id.toString(16);
}

function serializeBlob(request: Request, blob: Blob): string {
  const model: Array<string | Uint8Array> = [blob.type];
  const newTask = createTask(
    request,
    model,
    null,
    false,
    request.abortableTasks,
    enableProfilerTimer &&
      (enableComponentPerformanceTrack || enableAsyncDebugInfo)
      ? performance.now() // TODO: This should really inherit the time from the task.
      : 0,
    null, // TODO: Currently we don't associate any debug information with
    null, // this object on the server. If it ends up erroring, it won't
    null, // have any context on the server but can on the client.
  );

  const reader = blob.stream().getReader();

  function progress(
    entry: {done: false, value: Uint8Array} | {done: true, value: void},
  ): Promise<void> | void {
    if (newTask.status !== PENDING) {
      return;
    }
    if (entry.done) {
      request.cacheController.signal.removeEventListener('abort', abortBlob);
      pingTask(request, newTask);
      return;
    }
    // TODO: Emit the chunk early and refer to it later by dedupe.
    model.push(entry.value);
    // $FlowFixMe[incompatible-call]
    return reader.read().then(progress).catch(error);
  }
  function error(reason: mixed) {
    if (newTask.status !== PENDING) {
      return;
    }
    request.cacheController.signal.removeEventListener('abort', abortBlob);
    erroredTask(request, newTask, reason);
    enqueueFlush(request);
    // $FlowFixMe should be able to pass mixed
    reader.cancel(reason).then(error, error);
  }
  function abortBlob() {
    if (newTask.status !== PENDING) {
      return;
    }
    const signal = request.cacheController.signal;
    signal.removeEventListener('abort', abortBlob);
    const reason = signal.reason;
    if (enableHalt && request.type === PRERENDER) {
      request.abortableTasks.delete(newTask);
      haltTask(newTask, request);
      finishHaltedTask(newTask, request);
    } else {
      // TODO: Make this use abortTask() instead.
      erroredTask(request, newTask, reason);
      enqueueFlush(request);
    }
    // $FlowFixMe should be able to pass mixed
    reader.cancel(reason).then(error, error);
  }

  request.cacheController.signal.addEventListener('abort', abortBlob);

  // $FlowFixMe[incompatible-call]
  reader.read().then(progress).catch(error);

  return '$B' + newTask.id.toString(16);
}

function escapeStringValue(value: string): string {
  if (value[0] === '$') {
    // We need to escape $ prefixed strings since we use those to encode
    // references to IDs and as special symbol values.
    return '$' + value;
  } else {
    return value;
  }
}

let modelRoot: null | ReactClientValue = false;

function renderModel(
  request: Request,
  task: Task,
  parent:
    | {+[key: string | number]: ReactClientValue}
    | $ReadOnlyArray<ReactClientValue>,
  key: string,
  value: ReactClientValue,
): ReactJSONValue {
  // First time we're serializing the key, we should add it to the size.
  serializedSize += key.length;

  const prevKeyPath = task.keyPath;
  const prevImplicitSlot = task.implicitSlot;
  try {
    return renderModelDestructive(request, task, parent, key, value);
  } catch (thrownValue) {
    // If the suspended/errored value was an element or lazy it can be reduced
    // to a lazy reference, so that it doesn't error the parent.
    const model = task.model;
    const wasReactNode =
      typeof model === 'object' &&
      model !== null &&
      ((model: any).$$typeof === REACT_ELEMENT_TYPE ||
        (model: any).$$typeof === REACT_LAZY_TYPE);

    if (request.status === ABORTING) {
      task.status = ABORTED;
      if (enableHalt && request.type === PRERENDER) {
        // This will create a new task and refer to it in this slot
        // the new task won't be retried because we are aborting
        return outlineHaltedTask(request, task, wasReactNode);
      }
      const errorId = (request.fatalError: any);
      if (wasReactNode) {
        return serializeLazyID(errorId);
      }
      return serializeByValueID(errorId);
    }

    const x =
      thrownValue === SuspenseException
        ? // This is a special type of exception used for Suspense. For historical
          // reasons, the rest of the Suspense implementation expects the thrown
          // value to be a thenable, because before `use` existed that was the
          // (unstable) API for suspending. This implementation detail can change
          // later, once we deprecate the old API in favor of `use`.
          getSuspendedThenable()
        : thrownValue;

    if (typeof x === 'object' && x !== null) {
      // $FlowFixMe[method-unbinding]
      if (typeof x.then === 'function') {
        // Something suspended, we'll need to create a new task and resolve it later.
        const newTask = createTask(
          request,
          task.model,
          task.keyPath,
          task.implicitSlot,
          request.abortableTasks,
          enableProfilerTimer &&
            (enableComponentPerformanceTrack || enableAsyncDebugInfo)
            ? task.time
            : 0,
          __DEV__ ? task.debugOwner : null,
          __DEV__ ? task.debugStack : null,
          __DEV__ ? task.debugTask : null,
        );
        const ping = newTask.ping;
        (x: any).then(ping, ping);
        newTask.thenableState = getThenableStateAfterSuspending();

        // Restore the context. We assume that this will be restored by the inner
        // functions in case nothing throws so we don't use "finally" here.
        task.keyPath = prevKeyPath;
        task.implicitSlot = prevImplicitSlot;

        if (wasReactNode) {
          return serializeLazyID(newTask.id);
        }
        return serializeByValueID(newTask.id);
      }
    }

    // Restore the context. We assume that this will be restored by the inner
    // functions in case nothing throws so we don't use "finally" here.
    task.keyPath = prevKeyPath;
    task.implicitSlot = prevImplicitSlot;

    // Something errored. We'll still send everything we have up until this point.
    request.pendingChunks++;
    const errorId = request.nextChunkId++;
    if (
      enablePostpone &&
      typeof x === 'object' &&
      x !== null &&
      x.$$typeof === REACT_POSTPONE_TYPE
    ) {
      // Something postponed. We'll still send everything we have up until this point.
      // We'll replace this element with a lazy reference that postpones on the client.
      const postponeInstance: Postpone = (x: any);
      logPostpone(request, postponeInstance.message, task);
      emitPostponeChunk(request, errorId, postponeInstance);
    } else {
      const digest = logRecoverableError(request, x, task);
      emitErrorChunk(request, errorId, digest, x, false);
    }
    if (wasReactNode) {
      // We'll replace this element with a lazy reference that throws on the client
      // once it gets rendered.
      return serializeLazyID(errorId);
    }
    // If we don't know if it was a React Node we render a direct reference and let
    // the client deal with it.
    return serializeByValueID(errorId);
  }
}

function renderModelDestructive(
  request: Request,
  task: Task,
  parent:
    | {+[propertyName: string | number]: ReactClientValue}
    | $ReadOnlyArray<ReactClientValue>,
  parentPropertyName: string,
  value: ReactClientValue,
): ReactJSONValue {
  // Set the currently rendering model
  task.model = value;

  // Special Symbol, that's very common.
  if (value === REACT_ELEMENT_TYPE) {
    return '$';
  }

  if (value === null) {
    return null;
  }

  if (typeof value === 'object') {
    switch ((value: any).$$typeof) {
      case REACT_ELEMENT_TYPE: {
        let elementReference = null;
        const writtenObjects = request.writtenObjects;
        if (task.keyPath !== null || task.implicitSlot) {
          // If we're in some kind of context we can't reuse the result of this render or
          // previous renders of this element. We only reuse elements if they're not wrapped
          // by another Server Component.
        } else {
          const existingReference = writtenObjects.get(value);
          if (existingReference !== undefined) {
            if (modelRoot === value) {
              // This is the ID we're currently emitting so we need to write it
              // once but if we discover it again, we refer to it by id.
              modelRoot = null;
            } else {
              // We've already emitted this as an outlined object, so we can refer to that by its
              // existing ID. TODO: We should use a lazy reference since, unlike plain objects,
              // elements might suspend so it might not have emitted yet even if we have the ID for
              // it. However, this creates an extra wrapper when it's not needed. We should really
              // detect whether this already was emitted and synchronously available. In that
              // case we can refer to it synchronously and only make it lazy otherwise.
              // We currently don't have a data structure that lets us see that though.
              return existingReference;
            }
          } else if (parentPropertyName.indexOf(':') === -1) {
            // TODO: If the property name contains a colon, we don't dedupe. Escape instead.
            const parentReference = writtenObjects.get(parent);
            if (parentReference !== undefined) {
              // If the parent has a reference, we can refer to this object indirectly
              // through the property name inside that parent.
              elementReference = parentReference + ':' + parentPropertyName;
              writtenObjects.set(value, elementReference);
            }
          }
        }

        const element: ReactElement = (value: any);

        if (serializedSize > MAX_ROW_SIZE) {
          return deferTask(request, task);
        }

        if (__DEV__) {
          const debugInfo: ?ReactDebugInfo = (value: any)._debugInfo;
          if (debugInfo) {
            // If this came from Flight, forward any debug info into this new row.
            if (!canEmitDebugInfo) {
              // We don't have a chunk to assign debug info. We need to outline this
              // component to assign it an ID.
              return outlineTask(request, task);
            } else {
              // Forward any debug info we have the first time we see it.
              forwardDebugInfo(request, task, debugInfo);
            }
          }
        }

        const props = element.props;
        // TODO: We should get the ref off the props object right before using
        // it.
        const refProp = props.ref;
        const ref = refProp !== undefined ? refProp : null;

        // Attempt to render the Server Component.

        if (__DEV__) {
          task.debugOwner = element._owner;
          task.debugStack = element._debugStack;
          task.debugTask = element._debugTask;
          // TODO: Pop this. Since we currently don't have a point where we can pop the stack
          // this debug information will be used for errors inside sibling properties that
          // are not elements. Leading to the wrong attribution on the server. We could fix
          // that if we switch to a proper stack instead of JSON.stringify's trampoline.
          // Attribution on the client is still correct since it has a pop.
        }

        const newChild = renderElement(
          request,
          task,
          element.type,
          // $FlowFixMe[incompatible-call] the key of an element is null | string
          element.key,
          ref,
          props,
          __DEV__ ? element._store.validated : 0,
        );
        if (
          typeof newChild === 'object' &&
          newChild !== null &&
          elementReference !== null
        ) {
          // If this element renders another object, we can now refer to that object through
          // the same location as this element.
          if (!writtenObjects.has(newChild)) {
            writtenObjects.set(newChild, elementReference);
          }
        }
        return newChild;
      }
      case REACT_LAZY_TYPE: {
        if (serializedSize > MAX_ROW_SIZE) {
          return deferTask(request, task);
        }

        // Reset the task's thenable state before continuing. If there was one, it was
        // from suspending the lazy before.
        task.thenableState = null;

        const lazy: LazyComponent<any, any> = (value: any);
        let resolvedModel;
        if (__DEV__) {
          resolvedModel = callLazyInitInDEV(lazy);
        } else {
          const payload = lazy._payload;
          const init = lazy._init;
          resolvedModel = init(payload);
        }
        if (request.status === ABORTING) {
          // lazy initializers are user code and could abort during render
          // we don't wan to return any value resolved from the lazy initializer
          // if it aborts so we interrupt rendering here
          // eslint-disable-next-line no-throw-literal
          throw null;
        }
        if (__DEV__) {
          const debugInfo: ?ReactDebugInfo = lazy._debugInfo;
          if (debugInfo) {
            // If this came from Flight, forward any debug info into this new row.
            if (!canEmitDebugInfo) {
              // We don't have a chunk to assign debug info. We need to outline this
              // component to assign it an ID.
              return outlineTask(request, task);
            } else {
              // Forward any debug info we have the first time we see it.
              // We do this after init so that we have received all the debug info
              // from the server by the time we emit it.
              forwardDebugInfo(request, task, debugInfo);
            }
          }
        }
        return renderModelDestructive(
          request,
          task,
          emptyRoot,
          '',
          resolvedModel,
        );
      }
      case REACT_LEGACY_ELEMENT_TYPE: {
        throw new Error(
          'A React Element from an older version of React was rendered. ' +
            'This is not supported. It can happen if:\n' +
            '- Multiple copies of the "react" package is used.\n' +
            '- A library pre-bundled an old copy of "react" or "react/jsx-runtime".\n' +
            '- A compiler tries to "inline" JSX instead of using the runtime.',
        );
      }
    }

    if (isClientReference(value)) {
      return serializeClientReference(
        request,
        parent,
        parentPropertyName,
        (value: any),
      );
    }

    if (request.temporaryReferences !== undefined) {
      const tempRef = resolveTemporaryReference(
        request.temporaryReferences,
        value,
      );
      if (tempRef !== undefined) {
        return serializeTemporaryReference(request, tempRef);
      }
    }

    if (enableTaint) {
      const tainted = TaintRegistryObjects.get(value);
      if (tainted !== undefined) {
        throwTaintViolation(tainted);
      }
    }

    const writtenObjects = request.writtenObjects;
    const existingReference = writtenObjects.get(value);
    // $FlowFixMe[method-unbinding]
    if (typeof value.then === 'function') {
      if (existingReference !== undefined) {
        if (task.keyPath !== null || task.implicitSlot) {
          // If we're in some kind of context we can't reuse the result of this render or
          // previous renders of this element. We only reuse Promises if they're not wrapped
          // by another Server Component.
          const promiseId = serializeThenable(request, task, (value: any));
          return serializePromiseID(promiseId);
        } else if (modelRoot === value) {
          // This is the ID we're currently emitting so we need to write it
          // once but if we discover it again, we refer to it by id.
          modelRoot = null;
        } else {
          // We've seen this promise before, so we can just refer to the same result.
          return existingReference;
        }
      }
      // We assume that any object with a .then property is a "Thenable" type,
      // or a Promise type. Either of which can be represented by a Promise.
      const promiseId = serializeThenable(request, task, (value: any));
      const promiseReference = serializePromiseID(promiseId);
      writtenObjects.set(value, promiseReference);
      return promiseReference;
    }

    if (existingReference !== undefined) {
      if (modelRoot === value) {
        if (existingReference !== serializeByValueID(task.id)) {
          // Turns out that we already have this root at a different reference.
          // Use that after all.
          return existingReference;
        }
        // This is the ID we're currently emitting so we need to write it
        // once but if we discover it again, we refer to it by id.
        modelRoot = null;
      } else {
        // We've already emitted this as an outlined object, so we can
        // just refer to that by its existing ID.
        return existingReference;
      }
    } else if (parentPropertyName.indexOf(':') === -1) {
      // TODO: If the property name contains a colon, we don't dedupe. Escape instead.
      const parentReference = writtenObjects.get(parent);
      if (parentReference !== undefined) {
        // If the parent has a reference, we can refer to this object indirectly
        // through the property name inside that parent.
        let propertyName = parentPropertyName;
        if (isArray(parent) && parent[0] === REACT_ELEMENT_TYPE) {
          // For elements, we've converted it to an array but we'll have converted
          // it back to an element before we read the references so the property
          // needs to be aliased.
          switch (parentPropertyName) {
            case '1':
              propertyName = 'type';
              break;
            case '2':
              propertyName = 'key';
              break;
            case '3':
              propertyName = 'props';
              break;
            case '4':
              propertyName = '_owner';
              break;
          }
        }
        writtenObjects.set(value, parentReference + ':' + propertyName);
      }
    }

    if (isArray(value)) {
      return renderFragment(request, task, value);
    }

    if (value instanceof Map) {
      return serializeMap(request, value);
    }
    if (value instanceof Set) {
      return serializeSet(request, value);
    }
    // TODO: FormData is not available in old Node. Remove the typeof later.
    if (typeof FormData === 'function' && value instanceof FormData) {
      return serializeFormData(request, value);
    }
    if (value instanceof Error) {
      return serializeErrorValue(request, value);
    }
    if (value instanceof ArrayBuffer) {
      return serializeTypedArray(request, 'A', new Uint8Array(value));
    }
    if (value instanceof Int8Array) {
      // char
      return serializeTypedArray(request, 'O', value);
    }
    if (value instanceof Uint8Array) {
      // unsigned char
      return serializeTypedArray(request, 'o', value);
    }
    if (value instanceof Uint8ClampedArray) {
      // unsigned clamped char
      return serializeTypedArray(request, 'U', value);
    }
    if (value instanceof Int16Array) {
      // sort
      return serializeTypedArray(request, 'S', value);
    }
    if (value instanceof Uint16Array) {
      // unsigned short
      return serializeTypedArray(request, 's', value);
    }
    if (value instanceof Int32Array) {
      // long
      return serializeTypedArray(request, 'L', value);
    }
    if (value instanceof Uint32Array) {
      // unsigned long
      return serializeTypedArray(request, 'l', value);
    }
    if (value instanceof Float32Array) {
      // float
      return serializeTypedArray(request, 'G', value);
    }
    if (value instanceof Float64Array) {
      // double
      return serializeTypedArray(request, 'g', value);
    }
    if (value instanceof BigInt64Array) {
      // number
      return serializeTypedArray(request, 'M', value);
    }
    if (value instanceof BigUint64Array) {
      // unsigned number
      // We use "m" instead of "n" since JSON can start with "null"
      return serializeTypedArray(request, 'm', value);
    }
    if (value instanceof DataView) {
      return serializeTypedArray(request, 'V', value);
    }
    // TODO: Blob is not available in old Node. Remove the typeof check later.
    if (typeof Blob === 'function' && value instanceof Blob) {
      return serializeBlob(request, value);
    }

    const iteratorFn = getIteratorFn(value);
    if (iteratorFn) {
      // TODO: Should we serialize the return value as well like we do for AsyncIterables?
      const iterator = iteratorFn.call(value);
      if (iterator === value) {
        // Iterator, not Iterable
        return serializeIterator(request, (iterator: any));
      }
      return renderFragment(request, task, Array.from((iterator: any)));
    }

    // TODO: Blob is not available in old Node. Remove the typeof check later.
    if (
      typeof ReadableStream === 'function' &&
      value instanceof ReadableStream
    ) {
      return serializeReadableStream(request, task, value);
    }
    const getAsyncIterator: void | (() => $AsyncIterator<any, any, any>) =
      (value: any)[ASYNC_ITERATOR];
    if (typeof getAsyncIterator === 'function') {
      // We treat AsyncIterables as a Fragment and as such we might need to key them.
      return renderAsyncFragment(request, task, (value: any), getAsyncIterator);
    }

    // We put the Date check low b/c most of the time Date's will already have been serialized
    // before we process it in this function but when rendering a Date() as a top level it can
    // end up being a Date instance here. This is rare so we deprioritize it by putting it deep
    // in this function
    if (value instanceof Date) {
      return serializeDate(value);
    }

    // Verify that this is a simple plain object.
    const proto = getPrototypeOf(value);
    if (
      proto !== ObjectPrototype &&
      (proto === null || getPrototypeOf(proto) !== null)
    ) {
      throw new Error(
        'Only plain objects, and a few built-ins, can be passed to Client Components ' +
          'from Server Components. Classes or null prototypes are not supported.' +
          describeObjectForErrorMessage(parent, parentPropertyName),
      );
    }
    if (__DEV__) {
      if (objectName(value) !== 'Object') {
        callWithDebugContextInDEV(request, task, () => {
          console.error(
            'Only plain objects can be passed to Client Components from Server Components. ' +
              '%s objects are not supported.%s',
            objectName(value),
            describeObjectForErrorMessage(parent, parentPropertyName),
          );
        });
      } else if (!isSimpleObject(value)) {
        callWithDebugContextInDEV(request, task, () => {
          console.error(
            'Only plain objects can be passed to Client Components from Server Components. ' +
              'Classes or other objects with methods are not supported.%s',
            describeObjectForErrorMessage(parent, parentPropertyName),
          );
        });
      } else if (Object.getOwnPropertySymbols) {
        const symbols = Object.getOwnPropertySymbols(value);
        if (symbols.length > 0) {
          callWithDebugContextInDEV(request, task, () => {
            console.error(
              'Only plain objects can be passed to Client Components from Server Components. ' +
                'Objects with symbol properties like %s are not supported.%s',
              symbols[0].description,
              describeObjectForErrorMessage(parent, parentPropertyName),
            );
          });
        }
      }
    }

    // $FlowFixMe[incompatible-return]
    return value;
  }

  if (typeof value === 'string') {
    if (enableTaint) {
      const tainted = TaintRegistryValues.get(value);
      if (tainted !== undefined) {
        throwTaintViolation(tainted.message);
      }
    }
    serializedSize += value.length;
    // TODO: Maybe too clever. If we support URL there's no similar trick.
    if (value[value.length - 1] === 'Z') {
      // Possibly a Date, whose toJSON automatically calls toISOString
      // $FlowFixMe[incompatible-use]
      const originalValue = parent[parentPropertyName];
      if (originalValue instanceof Date) {
        return serializeDateFromDateJSON(value);
      }
    }
    if (value.length >= 1024 && byteLengthOfChunk !== null) {
      // For large strings, we encode them outside the JSON payload so that we
      // don't have to double encode and double parse the strings. This can also
      // be more compact in case the string has a lot of escaped characters.
      return serializeLargeTextString(request, value);
    }
    return escapeStringValue(value);
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return serializeNumber(value);
  }

  if (typeof value === 'undefined') {
    return serializeUndefined();
  }

  if (typeof value === 'function') {
    if (isClientReference(value)) {
      return serializeClientReference(
        request,
        parent,
        parentPropertyName,
        (value: any),
      );
    }
    if (isServerReference(value)) {
      return serializeServerReference(request, (value: any));
    }
    if (request.temporaryReferences !== undefined) {
      const tempRef = resolveTemporaryReference(
        request.temporaryReferences,
        value,
      );
      if (tempRef !== undefined) {
        return serializeTemporaryReference(request, tempRef);
      }
    }

    if (enableTaint) {
      const tainted = TaintRegistryObjects.get(value);
      if (tainted !== undefined) {
        throwTaintViolation(tainted);
      }
    }

    if (isOpaqueTemporaryReference(value)) {
      throw new Error(
        'Could not reference an opaque temporary reference. ' +
          'This is likely due to misconfiguring the temporaryReferences options ' +
          'on the server.',
      );
    } else if (/^on[A-Z]/.test(parentPropertyName)) {
      throw new Error(
        'Event handlers cannot be passed to Client Component props.' +
          describeObjectForErrorMessage(parent, parentPropertyName) +
          '\nIf you need interactivity, consider converting part of this to a Client Component.',
      );
    } else if (
      __DEV__ &&
      (jsxChildrenParents.has(parent) ||
        (jsxPropsParents.has(parent) && parentPropertyName === 'children'))
    ) {
      const componentName = value.displayName || value.name || 'Component';
      throw new Error(
        'Functions are not valid as a child of Client Components. This may happen if ' +
          'you return ' +
          componentName +
          ' instead of <' +
          componentName +
          ' /> from render. ' +
          'Or maybe you meant to call this function rather than return it.' +
          describeObjectForErrorMessage(parent, parentPropertyName),
      );
    } else {
      throw new Error(
        'Functions cannot be passed directly to Client Components ' +
          'unless you explicitly expose it by marking it with "use server". ' +
          'Or maybe you meant to call this function rather than return it.' +
          describeObjectForErrorMessage(parent, parentPropertyName),
      );
    }
  }

  if (typeof value === 'symbol') {
    const writtenSymbols = request.writtenSymbols;
    const existingId = writtenSymbols.get(value);
    if (existingId !== undefined) {
      return serializeByValueID(existingId);
    }
    // $FlowFixMe[incompatible-type] `description` might be undefined
    const name: string = value.description;

    if (Symbol.for(name) !== value) {
      throw new Error(
        'Only global symbols received from Symbol.for(...) can be passed to Client Components. ' +
          `The symbol Symbol.for(${
            // $FlowFixMe[incompatible-type] `description` might be undefined
            value.description
          }) cannot be found among global symbols.` +
          describeObjectForErrorMessage(parent, parentPropertyName),
      );
    }

    request.pendingChunks++;
    const symbolId = request.nextChunkId++;
    emitSymbolChunk(request, symbolId, name);
    writtenSymbols.set(value, symbolId);
    return serializeByValueID(symbolId);
  }

  if (typeof value === 'bigint') {
    if (enableTaint) {
      const tainted = TaintRegistryValues.get(value);
      if (tainted !== undefined) {
        throwTaintViolation(tainted.message);
      }
    }
    return serializeBigInt(value);
  }

  throw new Error(
    `Type ${typeof value} is not supported in Client Component props.` +
      describeObjectForErrorMessage(parent, parentPropertyName),
  );
}

function logPostpone(
  request: Request,
  reason: string,
  task: Task | null, // DEV-only
): void {
  const prevRequest = currentRequest;
  // We clear the request context so that console.logs inside the callback doesn't
  // get forwarded to the client.
  currentRequest = null;
  try {
    const onPostpone = request.onPostpone;
    if (__DEV__ && task !== null) {
      if (supportsRequestStorage) {
        requestStorage.run(
          undefined,
          callWithDebugContextInDEV,
          request,
          task,
          onPostpone,
          reason,
        );
      } else {
        callWithDebugContextInDEV(request, task, onPostpone, reason);
      }
    } else if (supportsRequestStorage) {
      // Exit the request context while running callbacks.
      requestStorage.run(undefined, onPostpone, reason);
    } else {
      onPostpone(reason);
    }
  } finally {
    currentRequest = prevRequest;
  }
}

function logRecoverableError(
  request: Request,
  error: mixed,
  task: Task | null, // DEV-only
): string {
  const prevRequest = currentRequest;
  // We clear the request context so that console.logs inside the callback doesn't
  // get forwarded to the client.
  currentRequest = null;
  let errorDigest;
  try {
    const onError = request.onError;
    if (__DEV__ && task !== null) {
      if (supportsRequestStorage) {
        errorDigest = requestStorage.run(
          undefined,
          callWithDebugContextInDEV,
          request,
          task,
          onError,
          error,
        );
      } else {
        errorDigest = callWithDebugContextInDEV(request, task, onError, error);
      }
    } else if (supportsRequestStorage) {
      // Exit the request context while running callbacks.
      errorDigest = requestStorage.run(undefined, onError, error);
    } else {
      errorDigest = onError(error);
    }
  } finally {
    currentRequest = prevRequest;
  }
  if (errorDigest != null && typeof errorDigest !== 'string') {
    // eslint-disable-next-line react-internal/prod-error-codes
    throw new Error(
      `onError returned something with a type other than "string". onError should return a string and may return null or undefined but must not return anything else. It received something of type "${typeof errorDigest}" instead`,
    );
  }
  return errorDigest || '';
}

function fatalError(request: Request, error: mixed): void {
  const onFatalError = request.onFatalError;
  onFatalError(error);
  if (enableTaint) {
    cleanupTaintQueue(request);
  }
  // This is called outside error handling code such as if an error happens in React internals.
  if (request.destination !== null) {
    request.status = CLOSED;
    closeWithError(request.destination, error);
  } else {
    request.status = CLOSING;
    request.fatalError = error;
  }
  const abortReason = new Error(
    'The render was aborted due to a fatal error.',
    {
      cause: error,
    },
  );
  request.cacheController.abort(abortReason);
}

function emitPostponeChunk(
  request: Request,
  id: number,
  postponeInstance: Postpone,
): void {
  let row;
  if (__DEV__) {
    let reason = '';
    let stack: ReactStackTrace;
    const env = request.environmentName();
    try {
      // eslint-disable-next-line react-internal/safe-string-coercion
      reason = String(postponeInstance.message);
      stack = filterStackTrace(request, parseStackTrace(postponeInstance, 0));
    } catch (x) {
      stack = [];
    }
    row = serializeRowHeader('P', id) + stringify({reason, stack, env}) + '\n';
  } else {
    // No reason included in prod.
    row = serializeRowHeader('P', id) + '\n';
  }
  const processedChunk = stringToChunk(row);
  request.completedErrorChunks.push(processedChunk);
}

function serializeErrorValue(request: Request, error: Error): string {
  if (__DEV__) {
    let name: string = 'Error';
    let message: string;
    let stack: ReactStackTrace;
    let env = (0, request.environmentName)();
    try {
      name = error.name;
      // eslint-disable-next-line react-internal/safe-string-coercion
      message = String(error.message);
      stack = filterStackTrace(request, parseStackTrace(error, 0));
      const errorEnv = (error: any).environmentName;
      if (typeof errorEnv === 'string') {
        // This probably came from another FlightClient as a pass through.
        // Keep the environment name.
        env = errorEnv;
      }
    } catch (x) {
      message = 'An error occurred but serializing the error message failed.';
      stack = [];
    }
    const errorInfo: ReactErrorInfoDev = {name, message, stack, env};
    const id = outlineModel(request, errorInfo);
    return '$Z' + id.toString(16);
  } else {
    // In prod we don't emit any information about this Error object to avoid
    // unintentional leaks. Since this doesn't actually throw on the server
    // we don't go through onError and so don't register any digest neither.
    return '$Z';
  }
}

function serializeDebugErrorValue(request: Request, error: Error): string {
  if (__DEV__) {
    let name: string = 'Error';
    let message: string;
    let stack: ReactStackTrace;
    let env = (0, request.environmentName)();
    try {
      name = error.name;
      // eslint-disable-next-line react-internal/safe-string-coercion
      message = String(error.message);
      stack = filterStackTrace(request, parseStackTrace(error, 0));
      const errorEnv = (error: any).environmentName;
      if (typeof errorEnv === 'string') {
        // This probably came from another FlightClient as a pass through.
        // Keep the environment name.
        env = errorEnv;
      }
    } catch (x) {
      message = 'An error occurred but serializing the error message failed.';
      stack = [];
    }
    const errorInfo: ReactErrorInfoDev = {name, message, stack, env};
    const id = outlineDebugModel(
      request,
      {objectLimit: stack.length * 2 + 1},
      errorInfo,
    );
    return '$Z' + id.toString(16);
  } else {
    // In prod we don't emit any information about this Error object to avoid
    // unintentional leaks. Since this doesn't actually throw on the server
    // we don't go through onError and so don't register any digest neither.
    return '$Z';
  }
}

function emitErrorChunk(
  request: Request,
  id: number,
  digest: string,
  error: mixed,
  debug: boolean,
): void {
  let errorInfo: ReactErrorInfo;
  if (__DEV__) {
    let name: string = 'Error';
    let message: string;
    let stack: ReactStackTrace;
    let env = (0, request.environmentName)();
    try {
      if (error instanceof Error) {
        name = error.name;
        // eslint-disable-next-line react-internal/safe-string-coercion
        message = String(error.message);
        stack = filterStackTrace(request, parseStackTrace(error, 0));
        const errorEnv = (error: any).environmentName;
        if (typeof errorEnv === 'string') {
          // This probably came from another FlightClient as a pass through.
          // Keep the environment name.
          env = errorEnv;
        }
      } else if (typeof error === 'object' && error !== null) {
        message = describeObjectForErrorMessage(error);
        stack = [];
      } else {
        // eslint-disable-next-line react-internal/safe-string-coercion
        message = String(error);
        stack = [];
      }
    } catch (x) {
      message = 'An error occurred but serializing the error message failed.';
      stack = [];
    }
    errorInfo = {digest, name, message, stack, env};
  } else {
    errorInfo = {digest};
  }
  const row = serializeRowHeader('E', id) + stringify(errorInfo) + '\n';
  const processedChunk = stringToChunk(row);
  if (__DEV__ && debug) {
    request.completedDebugChunks.push(processedChunk);
  } else {
    request.completedErrorChunks.push(processedChunk);
  }
}

function emitImportChunk(
  request: Request,
  id: number,
  clientReferenceMetadata: ClientReferenceMetadata,
  debug: boolean,
): void {
  // $FlowFixMe[incompatible-type] stringify can return null
  const json: string = stringify(clientReferenceMetadata);
  const row = serializeRowHeader('I', id) + json + '\n';
  const processedChunk = stringToChunk(row);
  if (__DEV__ && debug) {
    request.completedDebugChunks.push(processedChunk);
  } else {
    request.completedImportChunks.push(processedChunk);
  }
}

function emitHintChunk<Code: HintCode>(
  request: Request,
  code: Code,
  model: HintModel<Code>,
): void {
  const json: string = stringify(model);
  const row = ':H' + code + json + '\n';
  const processedChunk = stringToChunk(row);
  request.completedHintChunks.push(processedChunk);
}

function emitSymbolChunk(request: Request, id: number, name: string): void {
  const symbolReference = serializeSymbolReference(name);
  const processedChunk = encodeReferenceChunk(request, id, symbolReference);
  request.completedImportChunks.push(processedChunk);
}

function emitModelChunk(request: Request, id: number, json: string): void {
  const row = id.toString(16) + ':' + json + '\n';
  const processedChunk = stringToChunk(row);
  request.completedRegularChunks.push(processedChunk);
}

function emitDebugHaltChunk(request: Request, id: number): void {
  if (!__DEV__) {
    // These errors should never make it into a build so we don't need to encode them in codes.json
    // eslint-disable-next-line react-internal/prod-error-codes
    throw new Error(
      'emitDebugHaltChunk should never be called in production mode. This is a bug in React.',
    );
  }
  // This emits a marker that this row will never complete and should intentionally never resolve
  // even when the client stream is closed. We use just the lack of data to indicate this.
  const row = id.toString(16) + ':\n';
  const processedChunk = stringToChunk(row);
  request.completedDebugChunks.push(processedChunk);
}

function emitDebugChunk(
  request: Request,
  id: number,
  debugInfo: ReactDebugInfoEntry,
): void {
  if (!__DEV__) {
    // These errors should never make it into a build so we don't need to encode them in codes.json
    // eslint-disable-next-line react-internal/prod-error-codes
    throw new Error(
      'emitDebugChunk should never be called in production mode. This is a bug in React.',
    );
  }

  const json: string = serializeDebugModel(request, 500, debugInfo);
  if (request.debugDestination !== null) {
    // Outline the actual timing information to the debug channel.
    const outlinedId = request.nextChunkId++;
    const debugRow = outlinedId.toString(16) + ':' + json + '\n';
    request.pendingDebugChunks++;
    request.completedDebugChunks.push(stringToChunk(debugRow));
    const row =
      serializeRowHeader('D', id) + '"$' + outlinedId.toString(16) + '"\n';
    request.completedRegularChunks.push(stringToChunk(row));
  } else {
    const row = serializeRowHeader('D', id) + json + '\n';
    request.completedRegularChunks.push(stringToChunk(row));
  }
}

function outlineComponentInfo(
  request: Request,
  componentInfo: ReactComponentInfo,
): void {
  if (!__DEV__) {
    // These errors should never make it into a build so we don't need to encode them in codes.json
    // eslint-disable-next-line react-internal/prod-error-codes
    throw new Error(
      'outlineComponentInfo should never be called in production mode. This is a bug in React.',
    );
  }

  if (request.writtenDebugObjects.has(componentInfo)) {
    // Already written
    return;
  }

  if (componentInfo.owner != null) {
    // Ensure the owner is already outlined.
    outlineComponentInfo(request, componentInfo.owner);
  }

  // Limit the number of objects we write to prevent emitting giant props objects.
  let objectLimit = 10;
  if (componentInfo.stack != null) {
    // Ensure we have enough object limit to encode the stack trace.
    objectLimit += componentInfo.stack.length;
  }

  // We use the console encoding so that we can dedupe objects but don't necessarily
  // use the full serialization that requires a task.
  const counter = {objectLimit};

  // We can't serialize the ConsoleTask/Error objects so we need to omit them before serializing.
  const componentDebugInfo: Omit<
    ReactComponentInfo,
    'debugTask' | 'debugStack',
  > = {
    name: componentInfo.name,
    key: componentInfo.key,
  };
  if (componentInfo.env != null) {
    // $FlowFixMe[cannot-write]
    componentDebugInfo.env = componentInfo.env;
  }
  if (componentInfo.owner != null) {
    // $FlowFixMe[cannot-write]
    componentDebugInfo.owner = componentInfo.owner;
  }
  if (componentInfo.stack == null && componentInfo.debugStack != null) {
    // If we have a debugStack but no parsed stack we should parse it.
    // $FlowFixMe[cannot-write]
    componentDebugInfo.stack = filterStackTrace(
      request,
      parseStackTrace(componentInfo.debugStack, 1),
    );
  } else if (componentInfo.stack != null) {
    // $FlowFixMe[cannot-write]
    componentDebugInfo.stack = componentInfo.stack;
  }
  // Ensure we serialize props after the stack to favor the stack being complete.
  // $FlowFixMe[cannot-write]
  componentDebugInfo.props = componentInfo.props;

  const id = outlineDebugModel(request, counter, componentDebugInfo);
  const ref = serializeByValueID(id);
  request.writtenDebugObjects.set(componentInfo, ref);
  // We also store this in the main dedupe set so that it can be referenced by inline React Elements.
  request.writtenObjects.set(componentInfo, ref);
}

function emitIOInfoChunk(
  request: Request,
  id: number,
  name: string,
  start: number,
  end: number,
  value: ?Promise<mixed>,
  env: ?string,
  owner: ?ReactComponentInfo,
  stack: ?ReactStackTrace,
): void {
  if (!__DEV__) {
    // These errors should never make it into a build so we don't need to encode them in codes.json
    // eslint-disable-next-line react-internal/prod-error-codes
    throw new Error(
      'emitIOInfoChunk should never be called in production mode. This is a bug in React.',
    );
  }

  let objectLimit = 10;
  if (stack) {
    objectLimit += stack.length;
  }

  const relativeStartTimestamp = start - request.timeOrigin;
  const relativeEndTimestamp = end - request.timeOrigin;
  const debugIOInfo: Omit<ReactIOInfo, 'debugTask' | 'debugStack'> = {
    name: name,
    start: relativeStartTimestamp,
    end: relativeEndTimestamp,
  };
  if (env != null) {
    // $FlowFixMe[cannot-write]
    debugIOInfo.env = env;
  }
  if (stack != null) {
    // $FlowFixMe[cannot-write]
    debugIOInfo.stack = stack;
  }
  if (owner != null) {
    // $FlowFixMe[cannot-write]
    debugIOInfo.owner = owner;
  }
  if (value !== undefined) {
    // $FlowFixMe[cannot-write]
    debugIOInfo.value = value;
  }
  const json: string = serializeDebugModel(request, objectLimit, debugIOInfo);
  const row = id.toString(16) + ':J' + json + '\n';
  const processedChunk = stringToChunk(row);
  request.completedDebugChunks.push(processedChunk);
}

function outlineIOInfo(request: Request, ioInfo: ReactIOInfo): void {
  if (request.writtenObjects.has(ioInfo)) {
    // Already written
    return;
  }
  // We can't serialize the ConsoleTask/Error objects so we need to omit them before serializing.
  request.pendingDebugChunks++;
  const id = request.nextChunkId++;
  const owner = ioInfo.owner;
  // Ensure the owner is already outlined.
  if (owner != null) {
    outlineComponentInfo(request, owner);
  }
  let debugStack;
  if (ioInfo.stack == null && ioInfo.debugStack != null) {
    // If we have a debugStack but no parsed stack we should parse it.
    debugStack = filterStackTrace(
      request,
      parseStackTrace(ioInfo.debugStack, 1),
    );
  } else {
    debugStack = ioInfo.stack;
  }
  emitIOInfoChunk(
    request,
    id,
    ioInfo.name,
    ioInfo.start,
    ioInfo.end,
    ioInfo.value,
    ioInfo.env,
    owner,
    debugStack,
  );
  request.writtenDebugObjects.set(ioInfo, serializeByValueID(id));
}

function serializeIONode(
  request: Request,
  ioNode: IONode | PromiseNode | UnresolvedPromiseNode,
  promiseRef: null | WeakRef<Promise<mixed>>,
): string {
  const existingRef = request.writtenDebugObjects.get(ioNode);
  if (existingRef !== undefined) {
    // Already written
    return existingRef;
  }

  let stack = null;
  let name = '';
  if (ioNode.stack !== null) {
    // The stack can contain some leading internal frames for the construction of the promise that we skip.
    const fullStack = stripLeadingPromiseCreationFrames(ioNode.stack);
    stack = filterStackTrace(request, fullStack);
    name = findCalledFunctionNameFromStackTrace(request, fullStack);
    // The name can include the object that this was called on but sometimes that's
    // just unnecessary context.
    if (name.startsWith('Window.')) {
      name = name.slice(7);
    } else if (name.startsWith('<anonymous>.')) {
      name = name.slice(7);
    }
  }
  const owner = ioNode.owner;
  // Ensure the owner is already outlined.
  if (owner != null) {
    outlineComponentInfo(request, owner);
  }

  let value: void | Promise<mixed> = undefined;
  if (promiseRef !== null) {
    value = promiseRef.deref();
  }

  // We log the environment at the time when we serialize the I/O node.
  // The environment name may have changed from when the I/O was actually started.
  const env = (0, request.environmentName)();

  const endTime =
    ioNode.tag === UNRESOLVED_PROMISE_NODE
      ? // Mark the end time as now. It's arbitrary since it's not resolved but this
        // marks when we called abort and therefore stopped trying.
        request.abortTime
      : ioNode.end;

  request.pendingDebugChunks++;
  const id = request.nextChunkId++;
  emitIOInfoChunk(
    request,
    id,
    name,
    ioNode.start,
    endTime,
    value,
    env,
    owner,
    stack,
  );
  const ref = serializeByValueID(id);
  request.writtenDebugObjects.set(ioNode, ref);
  return ref;
}

function emitTypedArrayChunk(
  request: Request,
  id: number,
  tag: string,
  typedArray: $ArrayBufferView,
  debug: boolean,
): void {
  if (enableTaint) {
    if (TaintRegistryByteLengths.has(typedArray.byteLength)) {
      // If we have had any tainted values of this length, we check
      // to see if these bytes matches any entries in the registry.
      const tainted = TaintRegistryValues.get(
        binaryToComparableString(typedArray),
      );
      if (tainted !== undefined) {
        throwTaintViolation(tainted.message);
      }
    }
  }
  if (debug) {
    request.pendingDebugChunks++;
  } else {
    request.pendingChunks++; // Extra chunk for the header.
  }
  // TODO: Convert to little endian if that's not the server default.
  const binaryChunk = typedArrayToBinaryChunk(typedArray);
  const binaryLength = byteLengthOfBinaryChunk(binaryChunk);
  const row = id.toString(16) + ':' + tag + binaryLength.toString(16) + ',';
  const headerChunk = stringToChunk(row);
  if (__DEV__ && debug) {
    request.completedDebugChunks.push(headerChunk, binaryChunk);
  } else {
    request.completedRegularChunks.push(headerChunk, binaryChunk);
  }
}

function emitTextChunk(
  request: Request,
  id: number,
  text: string,
  debug: boolean,
): void {
  if (byteLengthOfChunk === null) {
    // eslint-disable-next-line react-internal/prod-error-codes
    throw new Error(
      'Existence of byteLengthOfChunk should have already been checked. This is a bug in React.',
    );
  }
  if (debug) {
    request.pendingDebugChunks++;
  } else {
    request.pendingChunks++; // Extra chunk for the header.
  }
  const textChunk = stringToChunk(text);
  const binaryLength = byteLengthOfChunk(textChunk);
  const row = id.toString(16) + ':T' + binaryLength.toString(16) + ',';
  const headerChunk = stringToChunk(row);
  if (__DEV__ && debug) {
    request.completedDebugChunks.push(headerChunk, textChunk);
  } else {
    request.completedRegularChunks.push(headerChunk, textChunk);
  }
}

function serializeEval(source: string): string {
  if (!__DEV__) {
    // These errors should never make it into a build so we don't need to encode them in codes.json
    // eslint-disable-next-line react-internal/prod-error-codes
    throw new Error(
      'serializeEval should never be called in production mode. This is a bug in React.',
    );
  }
  return '$E' + source;
}

const CONSTRUCTOR_MARKER: symbol = __DEV__ ? Symbol() : (null: any);

let debugModelRoot: mixed = null;
let debugNoOutline: mixed = null;
// This is a forked version of renderModel which should never error, never suspend and is limited
// in the depth it can encode.
function renderDebugModel(
  request: Request,
  counter: {objectLimit: number},
  parent:
    | {+[propertyName: string | number]: ReactClientValue}
    | $ReadOnlyArray<ReactClientValue>,
  parentPropertyName: string,
  value: ReactClientValue,
): ReactJSONValue {
  if (value === null) {
    return null;
  }

  // Special Symbol, that's very common.
  if (value === REACT_ELEMENT_TYPE) {
    return '$';
  }

  if (typeof value === 'object') {
    if (isClientReference(value)) {
      // We actually have this value on the client so we could import it.
      // This might be confusing though because on the Server it won't actually
      // be this value, so if you're debugging client references maybe you'd be
      // better with a place holder.
      return serializeDebugClientReference(
        request,
        parent,
        parentPropertyName,
        (value: any),
      );
    }
    if (value.$$typeof === CONSTRUCTOR_MARKER) {
      const constructor: Function = (value: any).constructor;
      let ref = request.writtenDebugObjects.get(constructor);
      if (ref === undefined) {
        const id = outlineDebugModel(request, counter, constructor);
        ref = serializeByValueID(id);
      }
      return '$P' + ref.slice(1);
    }

    if (request.temporaryReferences !== undefined) {
      const tempRef = resolveTemporaryReference(
        request.temporaryReferences,
        value,
      );
      if (tempRef !== undefined) {
        return serializeTemporaryReference(request, tempRef);
      }
    }

    const writtenDebugObjects = request.writtenDebugObjects;
    const existingDebugReference = writtenDebugObjects.get(value);
    if (existingDebugReference !== undefined) {
      if (debugModelRoot === value) {
        // This is the ID we're currently emitting so we need to write it
        // once but if we discover it again, we refer to it by id.
        debugModelRoot = null;
      } else {
        // We've already emitted this as a debug object. We favor that version if available.
        return existingDebugReference;
      }
    } else if (parentPropertyName.indexOf(':') === -1) {
      // TODO: If the property name contains a colon, we don't dedupe. Escape instead.
      const parentReference = writtenDebugObjects.get(parent);
      if (parentReference !== undefined) {
        // If the parent has a reference, we can refer to this object indirectly
        // through the property name inside that parent.
        if (counter.objectLimit <= 0 && !doNotLimit.has(value)) {
          // If we are going to defer this, don't dedupe it since then we'd dedupe it to be
          // deferred in future reference.
          return serializeDeferredObject(request, value);
        }

        let propertyName = parentPropertyName;
        if (isArray(parent) && parent[0] === REACT_ELEMENT_TYPE) {
          // For elements, we've converted it to an array but we'll have converted
          // it back to an element before we read the references so the property
          // needs to be aliased.
          switch (parentPropertyName) {
            case '1':
              propertyName = 'type';
              break;
            case '2':
              propertyName = 'key';
              break;
            case '3':
              propertyName = 'props';
              break;
            case '4':
              propertyName = '_owner';
              break;
          }
        }
        writtenDebugObjects.set(value, parentReference + ':' + propertyName);
      } else if (debugNoOutline !== value) {
        // If this isn't the root object (like meta data) and we don't have an id for it, outline
        // it so that we can dedupe it by reference later.
        // $FlowFixMe[method-unbinding]
        if (typeof value.then === 'function') {
          // If this is a Promise we're going to assign it an external ID anyway which can be deduped.
          const thenable: Thenable<any> = (value: any);
          return serializeDebugThenable(request, counter, thenable);
        } else {
          const outlinedId = outlineDebugModel(request, counter, value);
          return serializeByValueID(outlinedId);
        }
      }
    }

    const writtenObjects = request.writtenObjects;
    const existingReference = writtenObjects.get(value);
    if (existingReference !== undefined) {
      // We've already emitted this as a real object, so we can refer to that by its existing reference.
      // This might be slightly different serialization than what renderDebugModel would've produced.
      return existingReference;
    }

    if (counter.objectLimit <= 0 && !doNotLimit.has(value)) {
      // We've reached our max number of objects to serialize across the wire so we serialize this
      // as a marker so that the client can error or lazy load this when accessed by the console.
      return serializeDeferredObject(request, value);
    }

    counter.objectLimit--;

    const deferredDebugObjects = request.deferredDebugObjects;
    if (deferredDebugObjects !== null) {
      const deferredId = deferredDebugObjects.existing.get(value);
      // We earlier deferred this same object. We're now going to eagerly emit it so let's emit it
      // at the same ID that we already used to refer to it.
      if (deferredId !== undefined) {
        deferredDebugObjects.existing.delete(value);
        deferredDebugObjects.retained.delete(deferredId);
        emitOutlinedDebugModelChunk(request, deferredId, counter, value);
        return serializeByValueID(deferredId);
      }
    }

    switch ((value: any).$$typeof) {
      case REACT_ELEMENT_TYPE: {
        const element: ReactElement = (value: any);

        if (element._owner != null) {
          outlineComponentInfo(request, element._owner);
        }
        if (typeof element.type === 'object' && element.type !== null) {
          // If the type is an object it can get cut off which shouldn't happen here.
          doNotLimit.add(element.type);
        }
        if (typeof element.key === 'object' && element.key !== null) {
          // This should never happen but just in case.
          doNotLimit.add(element.key);
        }
        doNotLimit.add(element.props);
        if (element._owner !== null) {
          doNotLimit.add(element._owner);
        }

        let debugStack: null | ReactStackTrace = null;
        if (element._debugStack != null) {
          // Outline the debug stack so that it doesn't get cut off.
          debugStack = filterStackTrace(
            request,
            parseStackTrace(element._debugStack, 1),
          );
          doNotLimit.add(debugStack);
          for (let i = 0; i < debugStack.length; i++) {
            doNotLimit.add(debugStack[i]);
          }
        }
        return [
          REACT_ELEMENT_TYPE,
          element.type,
          element.key,
          element.props,
          element._owner,
          debugStack,
          element._store.validated,
        ];
      }
    }

    // $FlowFixMe[method-unbinding]
    if (typeof value.then === 'function') {
      const thenable: Thenable<any> = (value: any);
      return serializeDebugThenable(request, counter, thenable);
    }

    if (isArray(value)) {
      return value;
    }

    if (value instanceof Map) {
      return serializeDebugMap(request, counter, value);
    }
    if (value instanceof Set) {
      return serializeDebugSet(request, counter, value);
    }
    // TODO: FormData is not available in old Node. Remove the typeof later.
    if (typeof FormData === 'function' && value instanceof FormData) {
      return serializeDebugFormData(request, value);
    }
    if (value instanceof Error) {
      return serializeDebugErrorValue(request, value);
    }
    if (value instanceof ArrayBuffer) {
      return serializeDebugTypedArray(request, 'A', new Uint8Array(value));
    }
    if (value instanceof Int8Array) {
      // char
      return serializeDebugTypedArray(request, 'O', value);
    }
    if (value instanceof Uint8Array) {
      // unsigned char
      return serializeDebugTypedArray(request, 'o', value);
    }
    if (value instanceof Uint8ClampedArray) {
      // unsigned clamped char
      return serializeDebugTypedArray(request, 'U', value);
    }
    if (value instanceof Int16Array) {
      // sort
      return serializeDebugTypedArray(request, 'S', value);
    }
    if (value instanceof Uint16Array) {
      // unsigned short
      return serializeDebugTypedArray(request, 's', value);
    }
    if (value instanceof Int32Array) {
      // long
      return serializeDebugTypedArray(request, 'L', value);
    }
    if (value instanceof Uint32Array) {
      // unsigned long
      return serializeDebugTypedArray(request, 'l', value);
    }
    if (value instanceof Float32Array) {
      // float
      return serializeDebugTypedArray(request, 'G', value);
    }
    if (value instanceof Float64Array) {
      // double
      return serializeDebugTypedArray(request, 'g', value);
    }
    if (value instanceof BigInt64Array) {
      // number
      return serializeDebugTypedArray(request, 'M', value);
    }
    if (value instanceof BigUint64Array) {
      // unsigned number
      // We use "m" instead of "n" since JSON can start with "null"
      return serializeDebugTypedArray(request, 'm', value);
    }
    if (value instanceof DataView) {
      return serializeDebugTypedArray(request, 'V', value);
    }
    // TODO: Blob is not available in old Node. Remove the typeof check later.
    if (typeof Blob === 'function' && value instanceof Blob) {
      return serializeDebugBlob(request, value);
    }

    const iteratorFn = getIteratorFn(value);
    if (iteratorFn) {
      return Array.from((value: any));
    }

    const proto = getPrototypeOf(value);
    if (proto !== ObjectPrototype && proto !== null) {
      const object: Object = value;
      const instanceDescription: Object = Object.create(null);
      for (const propName in object) {
        if (hasOwnProperty.call(value, propName) || isGetter(proto, propName)) {
          // We intentionally invoke getters on the prototype to read any enumerable getters.
          instanceDescription[propName] = object[propName];
        }
      }
      const constructor = proto.constructor;
      if (
        typeof constructor === 'function' &&
        constructor.prototype === proto
      ) {
        // This is a simple class shape.
        if (hasOwnProperty.call(object, '') || isGetter(proto, '')) {
          // This object already has an empty property name. Skip encoding its prototype.
        } else {
          instanceDescription[''] = {
            $$typeof: CONSTRUCTOR_MARKER,
            constructor: constructor,
          };
        }
      }
      return instanceDescription;
    }

    // $FlowFixMe[incompatible-return]
    return value;
  }

  if (typeof value === 'string') {
    if (value[value.length - 1] === 'Z') {
      // Possibly a Date, whose toJSON automatically calls toISOString
      // Make sure that `parent[parentPropertyName]` wasn't JSONified before `value` was passed to us
      // $FlowFixMe[incompatible-use]
      const originalValue = parent[parentPropertyName];
      if (originalValue instanceof Date) {
        return serializeDateFromDateJSON(value);
      }
    }
    if (value.length >= 1024) {
      // Large strings are counted towards the object limit.
      if (counter.objectLimit <= 0) {
        // We've reached our max number of objects to serialize across the wire so we serialize this
        // as a marker so that the client can error or lazy load this when accessed by the console.
        return serializeDeferredObject(request, value);
      }
      counter.objectLimit--;
      // For large strings, we encode them outside the JSON payload so that we
      // don't have to double encode and double parse the strings. This can also
      // be more compact in case the string has a lot of escaped characters.
      return serializeDebugLargeTextString(request, value);
    }
    return escapeStringValue(value);
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return serializeNumber(value);
  }

  if (typeof value === 'undefined') {
    return serializeUndefined();
  }

  if (typeof value === 'function') {
    if (isClientReference(value)) {
      return serializeDebugClientReference(
        request,
        parent,
        parentPropertyName,
        (value: any),
      );
    }
    if (request.temporaryReferences !== undefined) {
      const tempRef = resolveTemporaryReference(
        request.temporaryReferences,
        value,
      );
      if (tempRef !== undefined) {
        return serializeTemporaryReference(request, tempRef);
      }
    }

    // Serialize the body of the function as an eval so it can be printed.
    const writtenDebugObjects = request.writtenDebugObjects;
    const existingReference = writtenDebugObjects.get(value);
    if (existingReference !== undefined) {
      // We've already emitted this function, so we can
      // just refer to that by its existing reference.
      return existingReference;
    }

    const serializedValue = serializeEval(
      // $FlowFixMe[method-unbinding]
      '(' + Function.prototype.toString.call(value) + ')',
    );
    request.pendingDebugChunks++;
    const id = request.nextChunkId++;
    const processedChunk = encodeReferenceChunk(request, id, serializedValue);
    request.completedDebugChunks.push(processedChunk);
    const reference = serializeByValueID(id);
    writtenDebugObjects.set(value, reference);
    return reference;
  }

  if (typeof value === 'symbol') {
    const writtenSymbols = request.writtenSymbols;
    const existingId = writtenSymbols.get(value);
    if (existingId !== undefined) {
      return serializeByValueID(existingId);
    }
    // $FlowFixMe[incompatible-type] `description` might be undefined
    const name: string = value.description;
    // We use the Symbol.for version if it's not a global symbol. Close enough.
    request.pendingChunks++;
    const symbolId = request.nextChunkId++;
    emitSymbolChunk(request, symbolId, name);
    return serializeByValueID(symbolId);
  }

  if (typeof value === 'bigint') {
    return serializeBigInt(value);
  }

  if (value instanceof Date) {
    return serializeDate(value);
  }

  return 'unknown type ' + typeof value;
}

function serializeDebugModel(
  request: Request,
  objectLimit: number,
  model: mixed,
): string {
  const counter = {objectLimit: objectLimit};

  function replacer(
    this:
      | {+[key: string | number]: ReactClientValue}
      | $ReadOnlyArray<ReactClientValue>,
    parentPropertyName: string,
    value: ReactClientValue,
  ): ReactJSONValue {
    try {
      return renderDebugModel(
        request,
        counter,
        this,
        parentPropertyName,
        value,
      );
    } catch (x) {
      return (
        'Unknown Value: React could not send it from the server.\n' + x.message
      );
    }
  }

  const prevNoOutline = debugNoOutline;
  debugNoOutline = model;
  try {
    // $FlowFixMe[incompatible-cast] stringify can return null
    return (stringify(model, replacer): string);
  } catch (x) {
    // $FlowFixMe[incompatible-cast] stringify can return null
    return (stringify(
      'Unknown Value: React could not send it from the server.\n' + x.message,
    ): string);
  } finally {
    debugNoOutline = prevNoOutline;
  }
}

function emitOutlinedDebugModelChunk(
  request: Request,
  id: number,
  counter: {objectLimit: number},
  model: ReactClientValue,
): void {
  if (!__DEV__) {
    // These errors should never make it into a build so we don't need to encode them in codes.json
    // eslint-disable-next-line react-internal/prod-error-codes
    throw new Error(
      'emitOutlinedDebugModel should never be called in production mode. This is a bug in React.',
    );
  }

  if (typeof model === 'object' && model !== null) {
    // We can't limit outlined values.
    doNotLimit.add(model);
  }

  function replacer(
    this:
      | {+[key: string | number]: ReactClientValue}
      | $ReadOnlyArray<ReactClientValue>,
    parentPropertyName: string,
    value: ReactClientValue,
  ): ReactJSONValue {
    try {
      return renderDebugModel(
        request,
        counter,
        this,
        parentPropertyName,
        value,
      );
    } catch (x) {
      return (
        'Unknown Value: React could not send it from the server.\n' + x.message
      );
    }
  }

  const prevModelRoot = debugModelRoot;
  debugModelRoot = model;
  if (typeof model === 'object' && model !== null) {
    // Future references can refer to this object by id.
    request.writtenDebugObjects.set(model, serializeByValueID(id));
  }
  let json: string;
  try {
    // $FlowFixMe[incompatible-cast] stringify can return null
    json = (stringify(model, replacer): string);
  } catch (x) {
    // $FlowFixMe[incompatible-cast] stringify can return null
    json = (stringify(
      'Unknown Value: React could not send it from the server.\n' + x.message,
    ): string);
  } finally {
    debugModelRoot = prevModelRoot;
  }

  const row = id.toString(16) + ':' + json + '\n';
  const processedChunk = stringToChunk(row);
  request.completedDebugChunks.push(processedChunk);
}

function outlineDebugModel(
  request: Request,
  counter: {objectLimit: number},
  model: ReactClientValue,
): number {
  if (!__DEV__) {
    // These errors should never make it into a build so we don't need to encode them in codes.json
    // eslint-disable-next-line react-internal/prod-error-codes
    throw new Error(
      'outlineDebugModel should never be called in production mode. This is a bug in React.',
    );
  }

  const id = request.nextChunkId++;
  request.pendingDebugChunks++;
  emitOutlinedDebugModelChunk(request, id, counter, model);
  return id;
}

function emitConsoleChunk(
  request: Request,
  methodName: string,
  owner: null | ReactComponentInfo,
  env: string,
  stackTrace: ReactStackTrace,
  args: Array<any>,
): void {
  if (!__DEV__) {
    // These errors should never make it into a build so we don't need to encode them in codes.json
    // eslint-disable-next-line react-internal/prod-error-codes
    throw new Error(
      'emitConsoleChunk should never be called in production mode. This is a bug in React.',
    );
  }

  // Ensure the owner is already outlined.
  if (owner != null) {
    outlineComponentInfo(request, owner);
  }

  const payload = [methodName, stackTrace, owner, env];
  // $FlowFixMe[method-unbinding]
  payload.push.apply(payload, args);
  const objectLimit = request.deferredDebugObjects === null ? 500 : 10;
  let json = serializeDebugModel(
    request,
    objectLimit + stackTrace.length,
    payload,
  );
  if (json[0] !== '[') {
    // This looks like an error. Try a simpler object.
    json = serializeDebugModel(request, 10 + stackTrace.length, [
      methodName,
      stackTrace,
      owner,
      env,
      'Unknown Value: React could not send it from the server.',
    ]);
  }
  const row = ':W' + json + '\n';
  const processedChunk = stringToChunk(row);
  request.completedDebugChunks.push(processedChunk);
}

function emitTimeOriginChunk(request: Request, timeOrigin: number): void {
  // We emit the time origin once. All ReactTimeInfo timestamps later in the stream
  // are relative to this time origin. This allows for more compact number encoding
  // and lower precision loss.
  request.pendingDebugChunks++;
  const row = ':N' + timeOrigin + '\n';
  const processedChunk = stringToChunk(row);
  // TODO: Move to its own priority queue.
  request.completedDebugChunks.push(processedChunk);
}

function forwardDebugInfo(
  request: Request,
  task: Task,
  debugInfo: ReactDebugInfo,
) {
  const id = task.id;
  for (let i = 0; i < debugInfo.length; i++) {
    const info = debugInfo[i];
    if (typeof info.time === 'number') {
      // When forwarding time we need to ensure to convert it to the time space of the payload.
      // We clamp the time to the starting render of the current component. It's as if it took
      // no time to render and await if we reuse cached content.
      markOperationEndTime(request, task, info.time);
    } else {
      if (typeof info.name === 'string') {
        // We outline this model eagerly so that we can refer to by reference as an owner.
        // If we had a smarter way to dedupe we might not have to do this if there ends up
        // being no references to this as an owner.
        outlineComponentInfo(request, (info: any));
        // Emit a reference to the outlined one.
        request.pendingChunks++;
        emitDebugChunk(request, id, info);
      } else if (info.awaited) {
        const ioInfo = info.awaited;
        if (ioInfo.end <= request.timeOrigin) {
          // This was already resolved when we started this render. It must have been some
          // externally cached data. We exclude that information but we keep components and
          // awaits that happened inside this render but might have been deduped within the
          // render.
        } else {
          // Outline the IO info in case the same I/O is awaited in more than one place.
          outlineIOInfo(request, ioInfo);
          // We can't serialize the ConsoleTask/Error objects so we need to omit them before serializing.
          let debugStack;
          if (info.stack == null && info.debugStack != null) {
            // If we have a debugStack but no parsed stack we should parse it.
            debugStack = filterStackTrace(
              request,
              parseStackTrace(info.debugStack, 1),
            );
          } else {
            debugStack = info.stack;
          }
          const debugAsyncInfo: Omit<
            ReactAsyncInfo,
            'debugTask' | 'debugStack',
          > = {
            awaited: ioInfo,
          };
          if (info.env != null) {
            // $FlowFixMe[cannot-write]
            debugAsyncInfo.env = info.env;
          }
          if (info.owner != null) {
            // $FlowFixMe[cannot-write]
            debugAsyncInfo.owner = info.owner;
          }
          if (debugStack != null) {
            // $FlowFixMe[cannot-write]
            debugAsyncInfo.stack = debugStack;
          }
          request.pendingChunks++;
          emitDebugChunk(request, id, debugAsyncInfo);
        }
      } else {
        request.pendingChunks++;
        emitDebugChunk(request, id, info);
      }
    }
  }
}

function forwardDebugInfoFromThenable(
  request: Request,
  task: Task,
  thenable: Thenable<any>,
  owner: null | ReactComponentInfo, // DEV-only
  stack: null | Error, // DEV-only
): void {
  let debugInfo: ?ReactDebugInfo;
  if (__DEV__) {
    // If this came from Flight, forward any debug info into this new row.
    debugInfo = thenable._debugInfo;
    if (debugInfo) {
      forwardDebugInfo(request, task, debugInfo);
    }
  }
  if (enableProfilerTimer && enableAsyncDebugInfo) {
    const sequence = getAsyncSequenceFromPromise(thenable);
    if (sequence !== null) {
      emitAsyncSequence(request, task, sequence, debugInfo, owner, stack);
    }
  }
}

function forwardDebugInfoFromCurrentContext(
  request: Request,
  task: Task,
  thenable: Thenable<any>,
): void {
  let debugInfo: ?ReactDebugInfo;
  if (__DEV__) {
    // If this came from Flight, forward any debug info into this new row.
    debugInfo = thenable._debugInfo;
    if (debugInfo) {
      forwardDebugInfo(request, task, debugInfo);
    }
  }
  if (enableProfilerTimer && enableAsyncDebugInfo) {
    const sequence = getCurrentAsyncSequence();
    if (sequence !== null) {
      emitAsyncSequence(request, task, sequence, debugInfo, null, null);
    }
  }
}

function forwardDebugInfoFromAbortedTask(request: Request, task: Task): void {
  // If a task is aborted, we can still include as much debug info as we can from the
  // value that we have so far.
  const model: any = task.model;
  if (typeof model !== 'object' || model === null) {
    return;
  }
  let debugInfo: ?ReactDebugInfo;
  if (__DEV__) {
    // If this came from Flight, forward any debug info into this new row.
    debugInfo = model._debugInfo;
    if (debugInfo) {
      forwardDebugInfo(request, task, debugInfo);
    }
  }
  if (enableProfilerTimer && enableAsyncDebugInfo) {
    let thenable: null | Thenable<any> = null;
    if (typeof model.then === 'function') {
      thenable = (model: any);
    } else if (model.$$typeof === REACT_LAZY_TYPE) {
      const payload = model._payload;
      if (typeof payload.then === 'function') {
        thenable = payload;
      }
    }
    if (thenable !== null) {
      const sequence = getAsyncSequenceFromPromise(thenable);
      if (sequence !== null) {
        let node = sequence;
        while (node.tag === UNRESOLVED_AWAIT_NODE && node.awaited !== null) {
          // See if any of the dependencies are resolved yet.
          node = node.awaited;
        }
        if (node.tag === UNRESOLVED_PROMISE_NODE) {
          // We don't know what Promise will eventually end up resolving this Promise and if it
          // was I/O at all. However, we assume that it was some kind of I/O since it didn't
          // complete in time before aborting.
          // The best we can do is try to emit the stack of where this Promise was created.
          serializeIONode(request, node, null);
          request.pendingChunks++;
          const env = (0, request.environmentName)();
          const asyncInfo: ReactAsyncInfo = {
            awaited: ((node: any): ReactIOInfo), // This is deduped by this reference.
            env: env,
          };
          // We don't have a start time for this await but in case there was no start time emitted
          // we need to include something. TODO: We should maybe ideally track the time when we
          // called .then() but without updating the task.time field since that's used for the cutoff.
          advanceTaskTime(request, task, task.time);
          emitDebugChunk(request, task.id, asyncInfo);
        } else {
          // We have a resolved Promise. Its debug info can include both awaited data and rejected
          // promises after the abort.
          emitAsyncSequence(request, task, sequence, debugInfo, null, null);
        }
      }
    }
  }
}

function emitTimingChunk(
  request: Request,
  id: number,
  timestamp: number,
): void {
  if (!enableProfilerTimer || !enableComponentPerformanceTrack) {
    return;
  }
  request.pendingChunks++;
  const relativeTimestamp = timestamp - request.timeOrigin;
  const json = '{"time":' + relativeTimestamp + '}';
  if (request.debugDestination !== null) {
    // Outline the actual timing information to the debug channel.
    const outlinedId = request.nextChunkId++;
    const debugRow = outlinedId.toString(16) + ':' + json + '\n';
    request.pendingDebugChunks++;
    request.completedDebugChunks.push(stringToChunk(debugRow));
    const row =
      serializeRowHeader('D', id) + '"$' + outlinedId.toString(16) + '"\n';
    request.completedRegularChunks.push(stringToChunk(row));
  } else {
    const row = serializeRowHeader('D', id) + json + '\n';
    request.completedRegularChunks.push(stringToChunk(row));
  }
}

function advanceTaskTime(
  request: Request,
  task: Task,
  timestamp: number,
): void {
  if (
    !enableProfilerTimer ||
    (!enableComponentPerformanceTrack && !enableAsyncDebugInfo)
  ) {
    return;
  }
  // Emits a timing chunk, if the new timestamp is higher than the previous timestamp of this task.
  if (timestamp > task.time) {
    emitTimingChunk(request, task.id, timestamp);
    task.time = timestamp;
  } else if (!task.timed) {
    // If it wasn't timed before, e.g. an outlined object, we need to emit the first timestamp and
    // it is now timed.
    emitTimingChunk(request, task.id, task.time);
  }
  task.timed = true;
}

function markOperationEndTime(request: Request, task: Task, timestamp: number) {
  if (
    !enableProfilerTimer ||
    (!enableComponentPerformanceTrack && !enableAsyncDebugInfo)
  ) {
    return;
  }
  // This is like advanceTaskTime() but always emits a timing chunk even if it doesn't advance.
  // This ensures that the end time of the previous entry isn't implied to be the start of the next one.
  if (request.status === ABORTING && timestamp > request.abortTime) {
    // If we're aborting then we don't emit any end times that happened after.
    return;
  }
  if (timestamp > task.time) {
    emitTimingChunk(request, task.id, timestamp);
    task.time = timestamp;
  } else {
    emitTimingChunk(request, task.id, task.time);
  }
}

function emitChunk(
  request: Request,
  task: Task,
  value: ReactClientValue,
): void {
  const id = task.id;
  // For certain types we have special types, we typically outlined them but
  // we can emit them directly for this row instead of through an indirection.
  if (typeof value === 'string' && byteLengthOfChunk !== null) {
    if (enableTaint) {
      const tainted = TaintRegistryValues.get(value);
      if (tainted !== undefined) {
        throwTaintViolation(tainted.message);
      }
    }
    emitTextChunk(request, id, value, false);
    return;
  }
  if (value instanceof ArrayBuffer) {
    emitTypedArrayChunk(request, id, 'A', new Uint8Array(value), false);
    return;
  }
  if (value instanceof Int8Array) {
    // char
    emitTypedArrayChunk(request, id, 'O', value, false);
    return;
  }
  if (value instanceof Uint8Array) {
    // unsigned char
    emitTypedArrayChunk(request, id, 'o', value, false);
    return;
  }
  if (value instanceof Uint8ClampedArray) {
    // unsigned clamped char
    emitTypedArrayChunk(request, id, 'U', value, false);
    return;
  }
  if (value instanceof Int16Array) {
    // sort
    emitTypedArrayChunk(request, id, 'S', value, false);
    return;
  }
  if (value instanceof Uint16Array) {
    // unsigned short
    emitTypedArrayChunk(request, id, 's', value, false);
    return;
  }
  if (value instanceof Int32Array) {
    // long
    emitTypedArrayChunk(request, id, 'L', value, false);
    return;
  }
  if (value instanceof Uint32Array) {
    // unsigned long
    emitTypedArrayChunk(request, id, 'l', value, false);
    return;
  }
  if (value instanceof Float32Array) {
    // float
    emitTypedArrayChunk(request, id, 'G', value, false);
    return;
  }
  if (value instanceof Float64Array) {
    // double
    emitTypedArrayChunk(request, id, 'g', value, false);
    return;
  }
  if (value instanceof BigInt64Array) {
    // number
    emitTypedArrayChunk(request, id, 'M', value, false);
    return;
  }
  if (value instanceof BigUint64Array) {
    // unsigned number
    // We use "m" instead of "n" since JSON can start with "null"
    emitTypedArrayChunk(request, id, 'm', value, false);
    return;
  }
  if (value instanceof DataView) {
    emitTypedArrayChunk(request, id, 'V', value, false);
    return;
  }
  // For anything else we need to try to serialize it using JSON.
  // $FlowFixMe[incompatible-type] stringify can return null for undefined but we never do
  const json: string = stringify(value, task.toJSON);
  emitModelChunk(request, task.id, json);
}

function erroredTask(request: Request, task: Task, error: mixed): void {
  if (
    enableProfilerTimer &&
    (enableComponentPerformanceTrack || enableAsyncDebugInfo)
  ) {
    if (task.timed) {
      markOperationEndTime(request, task, performance.now());
    }
  }
  task.status = ERRORED;
  if (
    enablePostpone &&
    typeof error === 'object' &&
    error !== null &&
    error.$$typeof === REACT_POSTPONE_TYPE
  ) {
    const postponeInstance: Postpone = (error: any);
    logPostpone(request, postponeInstance.message, task);
    emitPostponeChunk(request, task.id, postponeInstance);
  } else {
    const digest = logRecoverableError(request, error, task);
    emitErrorChunk(request, task.id, digest, error, false);
  }
  request.abortableTasks.delete(task);
  callOnAllReadyIfReady(request);
}

const emptyRoot = {};

function retryTask(request: Request, task: Task): void {
  if (task.status !== PENDING) {
    // We completed this by other means before we had a chance to retry it.
    return;
  }

  const prevCanEmitDebugInfo = canEmitDebugInfo;
  task.status = RENDERING;

  // We stash the outer parent size so we can restore it when we exit.
  const parentSerializedSize = serializedSize;
  // We don't reset the serialized size counter from reentry because that indicates that we
  // are outlining a model and we actually want to include that size into the parent since
  // it will still block the parent row. It only restores to zero at the top of the stack.
  try {
    // Track the root so we know that we have to emit this object even though it
    // already has an ID. This is needed because we might see this object twice
    // in the same toJSON if it is cyclic.
    modelRoot = task.model;

    if (__DEV__) {
      // Track that we can emit debug info for the current task.
      canEmitDebugInfo = true;
    }

    // We call the destructive form that mutates this task. That way if something
    // suspends again, we can reuse the same task instead of spawning a new one.
    const resolvedModel = renderModelDestructive(
      request,
      task,
      emptyRoot,
      '',
      task.model,
    );

    if (__DEV__) {
      // We're now past rendering this task and future renders will spawn new tasks for their
      // debug info.
      canEmitDebugInfo = false;
    }

    // Track the root again for the resolved object.
    modelRoot = resolvedModel;

    // The keyPath resets at any terminal child node.
    task.keyPath = null;
    task.implicitSlot = false;

    if (__DEV__) {
      const currentEnv = (0, request.environmentName)();
      if (currentEnv !== task.environmentName) {
        request.pendingChunks++;
        // The environment changed since we last emitted any debug information for this
        // task. We emit an entry that just includes the environment name change.
        emitDebugChunk(request, task.id, {env: currentEnv});
      }
    }
    // We've finished rendering. Log the end time.
    if (
      enableProfilerTimer &&
      (enableComponentPerformanceTrack || enableAsyncDebugInfo)
    ) {
      if (task.timed) {
        markOperationEndTime(request, task, performance.now());
      }
    }

    if (typeof resolvedModel === 'object' && resolvedModel !== null) {
      // We're not in a contextual place here so we can refer to this object by this ID for
      // any future references.
      request.writtenObjects.set(resolvedModel, serializeByValueID(task.id));

      // Object might contain unresolved values like additional elements.
      // This is simulating what the JSON loop would do if this was part of it.
      emitChunk(request, task, resolvedModel);
    } else {
      // If the value is a string, it means it's a terminal value and we already escaped it
      // We don't need to escape it again so it's not passed the toJSON replacer.
      // $FlowFixMe[incompatible-type] stringify can return null for undefined but we never do
      const json: string = stringify(resolvedModel);
      emitModelChunk(request, task.id, json);
    }

    task.status = COMPLETED;
    request.abortableTasks.delete(task);
    callOnAllReadyIfReady(request);
  } catch (thrownValue) {
    if (request.status === ABORTING) {
      request.abortableTasks.delete(task);
      task.status = PENDING;
      if (enableHalt && request.type === PRERENDER) {
        // When aborting a prerener with halt semantics we don't emit
        // anything into the slot for a task that aborts, it remains unresolved
        haltTask(task, request);
        finishHaltedTask(task, request);
      } else {
        // Otherwise we emit an error chunk into the task slot.
        const errorId: number = (request.fatalError: any);
        abortTask(task, request, errorId);
        finishAbortedTask(task, request, errorId);
      }
      return;
    }

    const x =
      thrownValue === SuspenseException
        ? // This is a special type of exception used for Suspense. For historical
          // reasons, the rest of the Suspense implementation expects the thrown
          // value to be a thenable, because before `use` existed that was the
          // (unstable) API for suspending. This implementation detail can change
          // later, once we deprecate the old API in favor of `use`.
          getSuspendedThenable()
        : thrownValue;
    if (typeof x === 'object' && x !== null) {
      // $FlowFixMe[method-unbinding]
      if (typeof x.then === 'function') {
        // Something suspended again, let's pick it back up later.
        task.status = PENDING;
        task.thenableState = getThenableStateAfterSuspending();
        const ping = task.ping;
        x.then(ping, ping);
        return;
      }
    }
    erroredTask(request, task, x);
  } finally {
    if (__DEV__) {
      canEmitDebugInfo = prevCanEmitDebugInfo;
    }
    serializedSize = parentSerializedSize;
  }
}

function tryStreamTask(request: Request, task: Task): void {
  // This is used to try to emit something synchronously but if it suspends,
  // we emit a reference to a new outlined task immediately instead.
  const prevCanEmitDebugInfo = canEmitDebugInfo;
  if (__DEV__) {
    // We can't emit debug into to a specific row of a stream task. Instead we leave
    // it false so that we instead outline the row to get a new canEmitDebugInfo if needed.
    canEmitDebugInfo = false;
  }
  const parentSerializedSize = serializedSize;
  try {
    emitChunk(request, task, task.model);
  } finally {
    serializedSize = parentSerializedSize;
    if (__DEV__) {
      canEmitDebugInfo = prevCanEmitDebugInfo;
    }
  }
}

function performWork(request: Request): void {
  markAsyncSequenceRootTask();

  const prevDispatcher = ReactSharedInternals.H;
  ReactSharedInternals.H = HooksDispatcher;
  const prevRequest = currentRequest;
  currentRequest = request;
  prepareToUseHooksForRequest(request);

  try {
    const pingedTasks = request.pingedTasks;
    request.pingedTasks = [];
    for (let i = 0; i < pingedTasks.length; i++) {
      const task = pingedTasks[i];
      retryTask(request, task);
    }
    flushCompletedChunks(request);
  } catch (error) {
    logRecoverableError(request, error, null);
    fatalError(request, error);
  } finally {
    ReactSharedInternals.H = prevDispatcher;
    resetHooksForRequest();
    currentRequest = prevRequest;
  }
}

function abortTask(task: Task, request: Request, errorId: number): void {
  if (task.status !== PENDING) {
    // If this is already completed/errored we don't abort it.
    // If currently rendering it will be aborted by the render
    return;
  }
  task.status = ABORTED;
}

function finishAbortedTask(
  task: Task,
  request: Request,
  errorId: number,
): void {
  if (task.status !== ABORTED) {
    return;
  }
  forwardDebugInfoFromAbortedTask(request, task);
  // Track when we aborted this task as its end time.
  if (
    enableProfilerTimer &&
    (enableComponentPerformanceTrack || enableAsyncDebugInfo)
  ) {
    if (task.timed) {
      markOperationEndTime(request, task, request.abortTime);
    }
  }
  // Instead of emitting an error per task.id, we emit a model that only
  // has a single value referencing the error.
  const ref = serializeByValueID(errorId);
  const processedChunk = encodeReferenceChunk(request, task.id, ref);
  request.completedErrorChunks.push(processedChunk);
}

function haltTask(task: Task, request: Request): void {
  if (task.status !== PENDING) {
    // If this is already completed/errored we don't abort it.
    // If currently rendering it will be aborted by the render
    return;
  }
  task.status = ABORTED;
}

function finishHaltedTask(task: Task, request: Request): void {
  if (task.status !== ABORTED) {
    return;
  }
  forwardDebugInfoFromAbortedTask(request, task);
  // We don't actually emit anything for this task id because we are intentionally
  // leaving the reference unfulfilled.
  request.pendingChunks--;
}

function flushCompletedChunks(request: Request): void {
  if (__DEV__ && request.debugDestination !== null) {
    const debugDestination = request.debugDestination;
    beginWriting(debugDestination);
    try {
      const debugChunks = request.completedDebugChunks;
      let i = 0;
      for (; i < debugChunks.length; i++) {
        request.pendingDebugChunks--;
        const chunk = debugChunks[i];
        writeChunkAndReturn(debugDestination, chunk);
      }
      debugChunks.splice(0, i);
    } finally {
      completeWriting(debugDestination);
    }
    flushBuffered(debugDestination);
  }
  const destination = request.destination;
  if (destination !== null) {
    beginWriting(destination);
    try {
      // We emit module chunks first in the stream so that
      // they can be preloaded as early as possible.
      const importsChunks = request.completedImportChunks;
      let i = 0;
      for (; i < importsChunks.length; i++) {
        request.pendingChunks--;
        const chunk = importsChunks[i];
        const keepWriting: boolean = writeChunkAndReturn(destination, chunk);
        if (!keepWriting) {
          request.destination = null;
          i++;
          break;
        }
      }
      importsChunks.splice(0, i);

      // Next comes hints.
      const hintChunks = request.completedHintChunks;
      i = 0;
      for (; i < hintChunks.length; i++) {
        const chunk = hintChunks[i];
        const keepWriting: boolean = writeChunkAndReturn(destination, chunk);
        if (!keepWriting) {
          request.destination = null;
          i++;
          break;
        }
      }
      hintChunks.splice(0, i);

      // Debug meta data comes before the model data because it will often end up blocking the model from
      // completing since the JSX will reference the debug data.
      if (__DEV__ && request.debugDestination === null) {
        const debugChunks = request.completedDebugChunks;
        i = 0;
        for (; i < debugChunks.length; i++) {
          request.pendingDebugChunks--;
          const chunk = debugChunks[i];
          const keepWriting: boolean = writeChunkAndReturn(destination, chunk);
          if (!keepWriting) {
            request.destination = null;
            i++;
            break;
          }
        }
        debugChunks.splice(0, i);
      }

      // Next comes model data.
      const regularChunks = request.completedRegularChunks;
      i = 0;
      for (; i < regularChunks.length; i++) {
        request.pendingChunks--;
        const chunk = regularChunks[i];
        const keepWriting: boolean = writeChunkAndReturn(destination, chunk);
        if (!keepWriting) {
          request.destination = null;
          i++;
          break;
        }
      }
      regularChunks.splice(0, i);

      // Finally, errors are sent. The idea is that it's ok to delay
      // any error messages and prioritize display of other parts of
      // the page.
      const errorChunks = request.completedErrorChunks;
      i = 0;
      for (; i < errorChunks.length; i++) {
        request.pendingChunks--;
        const chunk = errorChunks[i];
        const keepWriting: boolean = writeChunkAndReturn(destination, chunk);
        if (!keepWriting) {
          request.destination = null;
          i++;
          break;
        }
      }
      errorChunks.splice(0, i);
    } finally {
      request.flushScheduled = false;
      completeWriting(destination);
    }
    flushBuffered(destination);
  }
  if (request.pendingChunks === 0) {
    if (__DEV__) {
      const debugDestination = request.debugDestination;
      if (request.pendingDebugChunks === 0) {
        // Continue fully closing both streams.
        if (debugDestination !== null) {
          close(debugDestination);
          request.debugDestination = null;
        }
      } else {
        // We still have debug information to write.
        if (debugDestination === null) {
          // We'll continue writing on this stream so nothing closes.
          return;
        } else {
          // We'll close the main stream but keep the debug stream open.
          // TODO: If this destination is not currently flowing we'll not close it when it resumes flowing.
          // We should keep a separate status for this.
          if (request.destination !== null) {
            request.status = CLOSED;
            close(request.destination);
            request.destination = null;
          }
          return;
        }
      }
    }
    // We're done.
    if (enableTaint) {
      cleanupTaintQueue(request);
    }
    if (request.status < ABORTING) {
      const abortReason = new Error(
        'This render completed successfully. All cacheSignals are now aborted to allow clean up of any unused resources.',
      );
      request.cacheController.abort(abortReason);
    }
    if (request.destination !== null) {
      request.status = CLOSED;
      close(request.destination);
      request.destination = null;
    }
    if (__DEV__ && request.debugDestination !== null) {
      close(request.debugDestination);
      request.debugDestination = null;
    }
  }
}

export function startWork(request: Request): void {
  request.flushScheduled = request.destination !== null;
  if (supportsRequestStorage) {
    scheduleMicrotask(() => {
      requestStorage.run(request, performWork, request);
    });
  } else {
    scheduleMicrotask(() => performWork(request));
  }
  scheduleWork(() => {
    if (request.status === OPENING) {
      request.status = OPEN;
    }
  });
}

function enqueueFlush(request: Request): void {
  if (
    request.flushScheduled === false &&
    // If there are pinged tasks we are going to flush anyway after work completes
    request.pingedTasks.length === 0 &&
    // If there is no destination there is nothing we can flush to. A flush will
    // happen when we start flowing again
    (request.destination !== null ||
      (__DEV__ && request.debugDestination !== null))
  ) {
    request.flushScheduled = true;
    // Unlike startWork and pingTask we intetionally use scheduleWork
    // here even during prerenders to allow as much batching as possible
    scheduleWork(() => {
      request.flushScheduled = false;
      flushCompletedChunks(request);
    });
  }
}

function callOnAllReadyIfReady(request: Request): void {
  if (request.abortableTasks.size === 0) {
    const onAllReady = request.onAllReady;
    onAllReady();
  }
}

export function startFlowing(request: Request, destination: Destination): void {
  if (request.status === CLOSING) {
    request.status = CLOSED;
    closeWithError(destination, request.fatalError);
    return;
  }
  if (request.status === CLOSED) {
    return;
  }
  if (request.destination !== null) {
    // We're already flowing.
    return;
  }
  request.destination = destination;
  try {
    flushCompletedChunks(request);
  } catch (error) {
    logRecoverableError(request, error, null);
    fatalError(request, error);
  }
}

export function startFlowingDebug(
  request: Request,
  debugDestination: Destination,
): void {
  if (request.status === CLOSING) {
    request.status = CLOSED;
    closeWithError(debugDestination, request.fatalError);
    return;
  }
  if (request.status === CLOSED) {
    return;
  }
  if (request.debugDestination !== null) {
    // We're already flowing.
    return;
  }
  request.debugDestination = debugDestination;
  try {
    flushCompletedChunks(request);
  } catch (error) {
    logRecoverableError(request, error, null);
    fatalError(request, error);
  }
}

export function stopFlowing(request: Request): void {
  request.destination = null;
}

function finishHalt(request: Request, abortedTasks: Set<Task>): void {
  try {
    abortedTasks.forEach(task => finishHaltedTask(task, request));
    const onAllReady = request.onAllReady;
    onAllReady();
    flushCompletedChunks(request);
  } catch (error) {
    logRecoverableError(request, error, null);
    fatalError(request, error);
  }
}

function finishAbort(
  request: Request,
  abortedTasks: Set<Task>,
  errorId: number,
): void {
  try {
    abortedTasks.forEach(task => finishAbortedTask(task, request, errorId));
    const onAllReady = request.onAllReady;
    onAllReady();
    flushCompletedChunks(request);
  } catch (error) {
    logRecoverableError(request, error, null);
    fatalError(request, error);
  }
}

export function abort(request: Request, reason: mixed): void {
  // We define any status below OPEN as OPEN equivalent
  if (request.status > OPEN) {
    return;
  }
  try {
    request.status = ABORTING;
    if (
      enableProfilerTimer &&
      (enableComponentPerformanceTrack || enableAsyncDebugInfo)
    ) {
      request.abortTime = performance.now();
    }
    request.cacheController.abort(reason);
    const abortableTasks = request.abortableTasks;
    if (abortableTasks.size > 0) {
      if (enableHalt && request.type === PRERENDER) {
        // When prerendering with halt semantics we simply halt the task
        // and leave the reference unfulfilled.
        abortableTasks.forEach(task => haltTask(task, request));
        scheduleWork(() => finishHalt(request, abortableTasks));
      } else if (
        enablePostpone &&
        typeof reason === 'object' &&
        reason !== null &&
        (reason: any).$$typeof === REACT_POSTPONE_TYPE
      ) {
        const postponeInstance: Postpone = (reason: any);
        logPostpone(request, postponeInstance.message, null);
        // When rendering we produce a shared postpone chunk and then
        // fulfill each task with a reference to that chunk.
        const errorId = request.nextChunkId++;
        request.fatalError = errorId;
        request.pendingChunks++;
        emitPostponeChunk(request, errorId, postponeInstance);
        abortableTasks.forEach(task => abortTask(task, request, errorId));
        scheduleWork(() => finishAbort(request, abortableTasks, errorId));
      } else {
        const error =
          reason === undefined
            ? new Error(
                'The render was aborted by the server without a reason.',
              )
            : typeof reason === 'object' &&
                reason !== null &&
                typeof reason.then === 'function'
              ? new Error(
                  'The render was aborted by the server with a promise.',
                )
              : reason;
        const digest = logRecoverableError(request, error, null);
        // When rendering we produce a shared error chunk and then
        // fulfill each task with a reference to that chunk.
        const errorId = request.nextChunkId++;
        request.fatalError = errorId;
        request.pendingChunks++;
        emitErrorChunk(request, errorId, digest, error, false);
        abortableTasks.forEach(task => abortTask(task, request, errorId));
        scheduleWork(() => finishAbort(request, abortableTasks, errorId));
      }
    } else {
      const onAllReady = request.onAllReady;
      onAllReady();
      flushCompletedChunks(request);
    }
  } catch (error) {
    logRecoverableError(request, error, null);
    fatalError(request, error);
  }
}

function fromHex(str: string): number {
  return parseInt(str, 16);
}

export function resolveDebugMessage(request: Request, message: string): void {
  if (!__DEV__) {
    // These errors should never make it into a build so we don't need to encode them in codes.json
    // eslint-disable-next-line react-internal/prod-error-codes
    throw new Error(
      'resolveDebugMessage should never be called in production mode. This is a bug in React.',
    );
  }
  const deferredDebugObjects = request.deferredDebugObjects;
  if (deferredDebugObjects === null) {
    throw new Error(
      "resolveDebugMessage/closeDebugChannel should not be called for a Request that wasn't kept alive. This is a bug in React.",
    );
  }
  if (message === '') {
    closeDebugChannel(request);
    return;
  }
  // This function lets the client ask for more data lazily through the debug channel.
  const command = message.charCodeAt(0);
  const ids = message.slice(2).split(',').map(fromHex);
  switch (command) {
    case 82 /* "R" */:
      // Release IDs
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const retainedValue = deferredDebugObjects.retained.get(id);
        if (retainedValue !== undefined) {
          // We're no longer blocked on this. We won't emit it.
          request.pendingDebugChunks--;
          deferredDebugObjects.retained.delete(id);
          deferredDebugObjects.existing.delete(retainedValue);
          enqueueFlush(request);
        }
      }
      break;
    case 81 /* "Q" */:
      // Query IDs
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const retainedValue = deferredDebugObjects.retained.get(id);
        if (retainedValue !== undefined) {
          // If we still have this object, and haven't emitted it before, emit it on the stream.
          const counter = {objectLimit: 10};
          deferredDebugObjects.retained.delete(id);
          deferredDebugObjects.existing.delete(retainedValue);
          emitOutlinedDebugModelChunk(request, id, counter, retainedValue);
          enqueueFlush(request);
        }
      }
      break;
    case 80 /* "P" */:
      // Query Promise IDs
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const retainedValue = deferredDebugObjects.retained.get(id);
        if (retainedValue !== undefined) {
          // If we still have this Promise, and haven't emitted it before, wait for it
          // and then emit it on the stream.
          const counter = {objectLimit: 10};
          deferredDebugObjects.retained.delete(id);
          emitRequestedDebugThenable(
            request,
            id,
            counter,
            (retainedValue: any),
          );
        }
      }
      break;
    default:
      throw new Error(
        'Unknown command. The debugChannel was not wired up properly.',
      );
  }
}

export function closeDebugChannel(request: Request): void {
  if (!__DEV__) {
    // These errors should never make it into a build so we don't need to encode them in codes.json
    // eslint-disable-next-line react-internal/prod-error-codes
    throw new Error(
      'closeDebugChannel should never be called in production mode. This is a bug in React.',
    );
  }
  // This clears all remaining deferred objects, potentially resulting in the completion of the Request.
  const deferredDebugObjects = request.deferredDebugObjects;
  if (deferredDebugObjects === null) {
    throw new Error(
      "resolveDebugMessage/closeDebugChannel should not be called for a Request that wasn't kept alive. This is a bug in React.",
    );
  }
  deferredDebugObjects.retained.forEach((value, id) => {
    request.pendingDebugChunks--;
    deferredDebugObjects.retained.delete(id);
    deferredDebugObjects.existing.delete(value);
  });
  enqueueFlush(request);
}
