import type { AuthContext } from '../middleware/auth.js';

/**
 * #2123: session-sensitive MCP consumers use the current request for either
 * principal shape, with initialization refusal as a fail-closed floor.
 * Retained worker attribution stays with the existing connection actor gate;
 * this projection neither publishes an actor nor changes credential scope.
 */
export function mcpRequestSessionContext(auth: AuthContext): Pick<AuthContext, 'sessionId' | 'sessionBindingRefused'> {
  return {
    // User transports retain their initialization binding as an attribution
    // floor. A later header cannot turn that worker into its human manager.
    // App-key N5 is request-local as before (#1749); it never grants person rights.
    sessionId: auth.userId
      ? auth.sessionId ?? auth.requestSession?.sessionId
      : auth.requestSession ? auth.requestSession.sessionId : auth.sessionId,
    sessionBindingRefused: auth.sessionBindingRefused === true || auth.requestSession?.refused === true,
  };
}
