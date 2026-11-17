import React, { createContext, useContext, useState, useEffect } from 'react';
import { repoService } from '../services/repoService';
import { sandboxService } from '../services/sandboxService';
import { mockRepositories } from '../data/mockRepositories';

const WorkspaceContext = createContext(null);

export const WorkspaceProvider = ({ children }) => {
  const [currentRepo, setCurrentRepo] = useState(mockRepositories[0]);
  const [currentBranch, setCurrentBranch] = useState('main');
  const [openTabs, setOpenTabs] = useState(['button.tsx', 'package.json', 'README.md']);
  const [activeTab, setActiveTab] = useState('button.tsx');
  const [fileContent, setFileContent] = useState('');
  const [mainViewMode, setMainViewMode] = useState('code'); // 'code' | 'readme' | 'deps'
  const [previewState, setPreviewState] = useState('running'); // 'running' | 'loading' | 'failed'
  const [previewDevice, setPreviewDevice] = useState('desktop'); // 'desktop' | 'mobile'
  const [isPreviewOpen, setIsPreviewOpen] = useState(true);
  const [terminalLogs, setTerminalLogs] = useState([
    '> vite v5.1.3 dev server running',
    '> Local: http://localhost:3000/',
    '> [vite] hot module reload connected'
  ]);
  const [loadingFile, setLoadingFile] = useState(false);

  // Load file content when activeTab or currentRepo changes
  useEffect(() => {
    if (activeTab === 'README.md') {
      setMainViewMode('readme');
    }
    setLoadingFile(true);
    repoService.getFileContent(currentRepo.fullName, activeTab)
      .then((content) => setFileContent(content))
      .catch(() => setFileContent('// Failed to load file content'))
      .finally(() => setLoadingFile(false));
  }, [activeTab, currentRepo]);

  const selectFile = (fileName) => {
    if (!openTabs.includes(fileName)) {
      setOpenTabs([...openTabs, fileName]);
    }
    setActiveTab(fileName);
    if (fileName === 'README.md') {
      setMainViewMode('readme');
    } else {
      setMainViewMode('code');
    }
  };

  const closeTab = (fileName, e) => {
    if (e) e.stopPropagation();
    const filtered = openTabs.filter((t) => t !== fileName);
    setOpenTabs(filtered);
    if (activeTab === fileName) {
      if (filtered.length > 0) {
        selectFile(filtered[filtered.length - 1]);
      } else {
        setActiveTab('');
        setFileContent('');
      }
    }
  };

  const switchBranch = (newBranch) => {
    setCurrentBranch(newBranch);
    triggerSandboxRefresh();
  };

  const triggerSandboxRefresh = () => {
    setPreviewState('loading');
    setTimeout(() => {
      setPreviewState('running');
    }, 700);
  };

  const cyclePreviewState = () => {
    if (previewState === 'running') setPreviewState('loading');
    else if (previewState === 'loading') setPreviewState('failed');
    else setPreviewState('running');
  };

  return (
    <WorkspaceContext.Provider
      value={{
        currentRepo,
        setCurrentRepo,
        currentBranch,
        switchBranch,
        openTabs,
        activeTab,
        selectFile,
        closeTab,
        fileContent,
        loadingFile,
        mainViewMode,
        setMainViewMode,
        previewState,
        setPreviewState,
        previewDevice,
        setPreviewDevice,
        isPreviewOpen,
        setIsPreviewOpen,
        terminalLogs,
        triggerSandboxRefresh,
        cyclePreviewState
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
};

export const useWorkspace = () => {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider');
  }
  return context;
};
