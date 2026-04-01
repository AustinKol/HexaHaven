import type { ScreenId } from '../../shared/constants/screenIds';
import type { ActionRejectedEvent } from '../../shared/types/socket';
import type { ClientRole, GameState } from '../../shared/types/domain';

export interface ClientState {
  currentScreen: ScreenId | null;
  clientId: string | null;
  playerId: string | null;
  role: ClientRole | null;
  gameState: GameState | null;
  lastActionRejected: ActionRejectedEvent | null;
}

export const clientState: ClientState = {
  currentScreen: null,
  clientId: null,
  playerId: null,
  role: null,
  gameState: null,
  lastActionRejected: null,
};

export type ClientStateListener = (state: ClientState) => void;

const listeners = new Set<ClientStateListener>();

export function subscribeClientState(listener: ClientStateListener): () => void {
  listeners.add(listener);
  listener(clientState);
  return () => listeners.delete(listener);
}

export function setClientState(patch: Partial<ClientState>): void {
  Object.assign(clientState, patch);
  listeners.forEach((listener) => listener(clientState));
}

export function resetClientState(): void {
  setClientState({
    currentScreen: null,
    clientId: null,
    playerId: null,
    role: null,
    gameState: null,
    lastActionRejected: null,
  });
}
