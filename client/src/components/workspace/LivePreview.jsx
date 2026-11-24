import React, { useCallback } from 'react';
import { useWorkspace } from '../../context/WorkspaceContext';
import { LivePreview as ProductionLivePreview } from '../preview/LivePreview';

/**
 * Workspace wrapper for LivePreview that binds repository context
 */
export const LivePreview = ({ width = 480 }) => {
  const {
    currentRepo,
    currentBranch,
    setIsPreviewOpen,
    previewState,
    setPreviewState,
    setPreviewPort,
    setPreviewSession,
    stopTriggerTimestamp,
  } = useWorkspace();

  const handleClose = useCallback(() => {
    setIsPreviewOpen(false);
  }, [setIsPreviewOpen]);

  const handleStatusChange = useCallback(
    ({ status, port, session }) => {
      setPreviewState(status?.toLowerCase() || 'idle');
      setPreviewPort(port || null);
      if (session) {
        setPreviewSession(session);
      }
    },
    [setPreviewState, setPreviewPort, setPreviewSession]
  );

  return (
    <ProductionLivePreview
      repositoryId={currentRepo?.id}
      commitRef={currentRepo?.latestCommitSha || currentBranch || 'main'}
      repoName={currentRepo?.name || currentRepo?.fullName || 'Repository Preview'}
      width={width}
      onClose={handleClose}
      onStatusChange={handleStatusChange}
      stopTriggerTimestamp={stopTriggerTimestamp}
    />
  );
};

export default LivePreview;
