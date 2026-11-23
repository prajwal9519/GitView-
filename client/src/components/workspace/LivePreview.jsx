import React, { useCallback } from 'react';
import { useWorkspace } from '../../context/WorkspaceContext';
import { LivePreview as ProductionLivePreview } from '../preview/LivePreview';

/**
 * Workspace wrapper for LivePreview that binds repository context
 */
export const LivePreview = ({ width = 480 }) => {
  const { currentRepo, currentBranch, setIsPreviewOpen, setPreviewState, setPreviewPort } = useWorkspace();

  const handleClose = useCallback(() => {
    setIsPreviewOpen(false);
  }, [setIsPreviewOpen]);

  const handleStatusChange = useCallback(
    ({ status, port }) => {
      setPreviewState(status?.toLowerCase() || 'idle');
      setPreviewPort(port || null);
    },
    [setPreviewState, setPreviewPort]
  );

  return (
    <ProductionLivePreview
      repositoryId={currentRepo?.id}
      commitRef={currentRepo?.latestCommitSha || currentBranch || 'main'}
      repoName={currentRepo?.name || currentRepo?.fullName || 'Repository Preview'}
      width={width}
      onClose={handleClose}
      onStatusChange={handleStatusChange}
    />
  );
};

export default LivePreview;
