let activeWorkflowTurnId: string | null = null;

export function beginWorkflowTurn(turnId: string) {
    activeWorkflowTurnId = turnId;
}

export function endWorkflowTurn(turnId?: string) {
    if (!turnId || activeWorkflowTurnId === turnId) activeWorkflowTurnId = null;
}

export function isWorkflowTurnActive() {
    return Boolean(activeWorkflowTurnId);
}
