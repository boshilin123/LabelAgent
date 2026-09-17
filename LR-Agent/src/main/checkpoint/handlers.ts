import { ipcMain } from 'electron';
import {
  captureCheckpoint,
  discardCheckpoint,
  hasCheckpoint,
  recordCheckpointAfter,
  restoreCheckpoint,
  type CheckpointKind,
  type CheckpointRef,
  type CheckpointRoots,
} from './turnCheckpointStore';

function asRef(value: CheckpointRef): CheckpointRef {
  return {
    sessionId: String(value.sessionId ?? ''),
    messageId: String(value.messageId ?? ''),
    blockIndex: Number(value.blockIndex),
  };
}

function asRoots(value: CheckpointRoots): CheckpointRoots {
  return {
    projectDir:
      typeof value.projectDir === 'string' ? value.projectDir : undefined,
    workspaceRoot:
      typeof value.workspaceRoot === 'string' ? value.workspaceRoot : undefined,
  };
}

export function registerCheckpointHandlers(): void {
  ipcMain.handle(
    'agent:checkpoint:capture',
    (
      _event,
      payload: CheckpointRef &
        CheckpointRoots & {
          kind: CheckpointKind;
          annotationPaths?: string[];
          filePaths?: string[];
        },
    ) => {
      return captureCheckpoint(asRef(payload), payload.kind, asRoots(payload), {
        annotationPaths: payload.annotationPaths,
        filePaths: payload.filePaths,
      });
    },
  );

  ipcMain.handle(
    'agent:checkpoint:recordAfter',
    (_event, payload: CheckpointRef & CheckpointRoots) => {
      return recordCheckpointAfter(asRef(payload), asRoots(payload));
    },
  );

  ipcMain.handle(
    'agent:checkpoint:restore',
    (_event, payload: CheckpointRef & CheckpointRoots) => {
      return restoreCheckpoint(asRef(payload), asRoots(payload));
    },
  );

  ipcMain.handle(
    'agent:checkpoint:discard',
    (_event, payload: CheckpointRef) => {
      return discardCheckpoint(asRef(payload));
    },
  );

  ipcMain.handle('agent:checkpoint:has', (_event, payload: CheckpointRef) => {
    return hasCheckpoint(asRef(payload));
  });
}
