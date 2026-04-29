import type { GameState, PlayerState } from '../../shared/types/domain';

// Demo 2 plan §Win Condition: first to 10 VP wins.
export const DEFAULT_VP_TO_WIN = 10;

export type WinEvaluation =
  | { winnerPlayerId: null }
  | { winnerPlayerId: string; reason: 'ALL_GOALS_COMPLETE' | 'ANY_X_GOALS_COMPLETE' | 'FIRST_TO_X_POINTS' };

function hasCompletedAllGoals(player: PlayerState): boolean {
  if (player.goals.length === 0) {
    return false;
  }
  return player.goals.every((goal) => goal.completed);
}

function countCompletedGoals(player: PlayerState): number {
  return player.goals.reduce((count, goal) => count + (goal.completed ? 1 : 0), 0);
}

export function evaluateWinner(gameState: GameState): WinEvaluation {
  if (gameState.roomStatus !== 'in_progress') {
    return { winnerPlayerId: null };
  }

  const { winRule, goalCount } = gameState.config;

  for (const playerId of gameState.playerOrder) {
    const player = gameState.playersById[playerId];
    if (!player) {
      continue;
    }

    // Temporary test behavior: VP threshold always wins regardless of room config.
    if (player.stats.publicVP >= DEFAULT_VP_TO_WIN) {
      return { winnerPlayerId: playerId, reason: 'FIRST_TO_X_POINTS' };
    }

    if (winRule === 'FIRST_TO_X_POINTS') {
      continue;
    }

    if (winRule === 'ALL_GOALS_COMPLETE') {
      if (hasCompletedAllGoals(player)) {
        return { winnerPlayerId: playerId, reason: 'ALL_GOALS_COMPLETE' };
      }
      continue;
    }

    if (winRule === 'ANY_X_GOALS_COMPLETE') {
      const threshold = goalCount > 0 ? goalCount : 1;
      if (countCompletedGoals(player) >= threshold) {
        return { winnerPlayerId: playerId, reason: 'ANY_X_GOALS_COMPLETE' };
      }
    }
  }

  return { winnerPlayerId: null };
}
