import { createContext, createElement, useContext, type ReactNode } from 'react';

const FigureAnimationContext = createContext(true);

/** Gate figures on a screen that remains mounted while it is unfocused. */
export function BotFigureAnimationProvider({ active, children }: { active: boolean; children: ReactNode }) {
  return createElement(FigureAnimationContext.Provider, { value: active }, children);
}

/** Defaults on for standalone figures outside a routed screen. */
export function useFigureAnimationActive(): boolean {
  return useContext(FigureAnimationContext);
}
