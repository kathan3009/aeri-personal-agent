import { createContext, useContext } from 'react';
import type { Tab } from './pending';

export type Nav = { go: (tab: Tab) => void; openSettings: () => void; openReview: (scanId: string) => void; bottomInset: number; keyboard: boolean };
export const NavContext = createContext<Nav>({ go: () => undefined, openSettings: () => undefined, openReview: () => undefined, bottomInset: 0, keyboard: false });
export const useNav = () => useContext(NavContext);
