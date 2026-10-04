import { createContext, useContext } from 'react';
import type { Tab } from './pending';

export type Nav = { go: (tab: Tab) => void; openSettings: () => void; bottomInset: number; keyboard: boolean };
export const NavContext = createContext<Nav>({ go: () => undefined, openSettings: () => undefined, bottomInset: 0, keyboard: false });
export const useNav = () => useContext(NavContext);
