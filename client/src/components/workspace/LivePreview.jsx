import React from 'react';
import { useWorkspace } from '../../context/WorkspaceContext';
import { LivePreview as ProductionLivePreview } from '../preview/LivePreview';

/**
 * Workspace wrapper for LivePreview that binds repository context
 */
export const LivePreview = ({ width = 480 }) => {
  const { currentRepo, currentBranch, setIsPreviewOpen } = useWorkspace();

  return (
    <ProductionLivePreview
      repositoryId={currentRepo?.id}
      commitRef={currentRepo?.latestCommitSha || currentBranch || 'main'}
      repoName={currentRepo?.name || currentRepo?.fullName || 'Repository Preview'}
      width={width}
      onClose={() => setIsPreviewOpen(false)}
    />
  );
};

export default LivePreview;
