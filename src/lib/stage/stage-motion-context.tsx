import { createContext, useContext, type ReactNode } from 'react';

const StageMotionContext = createContext(true);

export function stageMotionActiveForDrawerStatus(status: 'open' | 'closed'): boolean {
  return status === 'closed';
}

export function StageMotionProvider({ active, children }: { active: boolean; children: ReactNode }) {
  return <StageMotionContext.Provider value={active}>{children}</StageMotionContext.Provider>;
}

export function useStageMotionActive(): boolean {
  return useContext(StageMotionContext);
}
