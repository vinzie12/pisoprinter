// Queue Manager for Piso Printer System
// Handles session-based queueing to prevent payment conflicts

class QueueManager {
    constructor() {
        this.queue = [];
        this.activeSession = null;
        this.sessionTimeout = 90000; // 90 seconds timeout for payment
        this.sessions = new Map(); // Store session details
        this.lastActivityTime = new Map(); // Track last activity per session
        this.MAX_QUEUE_SIZE = 10; // Maximum queue size to prevent memory issues
        this.completedSessions = 0; // Track completed sessions for debugging
    }

    // Generate unique session ID
    generateSessionId() {
        return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    // Add user to queue
    joinQueue(sessionId, fileInfo) {
        // Check if session already exists
        if (this.sessions.has(sessionId)) {
            return this.getQueueStatus(sessionId);
        }

        // Check queue size limit
        if (this.queue.length >= this.MAX_QUEUE_SIZE && this.activeSession) {
            console.log(`⚠️ Queue is full (${this.queue.length}/${this.MAX_QUEUE_SIZE}). Rejecting new session.`);
            return {
                exists: false,
                success: false,
                error: 'Queue is full. Please try again later.',
                queueFull: true
            };
        }

        // Add new session
        this.sessions.set(sessionId, {
            id: sessionId,
            fileInfo: fileInfo,
            joinedAt: Date.now(),
            status: 'waiting'
        });

        // If no active session, make this session active immediately
        if (!this.activeSession) {
            this.activeSession = sessionId;
            const session = this.sessions.get(sessionId);
            session.status = 'active';
            session.activatedAt = Date.now();
            this.lastActivityTime.set(sessionId, Date.now());
            
            // Set timeout for this session
            setTimeout(() => {
                this.checkSessionTimeout(sessionId);
            }, this.sessionTimeout);
            
            console.log(`🎯 Session ${sessionId} is immediately active (first in queue) [Completed: ${this.completedSessions}]`);
        } else {
            // Add to queue if there's already an active session
            if (!this.queue.includes(sessionId)) {
                this.queue.push(sessionId);
                console.log(`📍 Session ${sessionId} added to queue at position ${this.queue.length} [Queue: ${this.queue.length}/${this.MAX_QUEUE_SIZE}]`);
            }
        }

        return this.getQueueStatus(sessionId);
    }

    // Process next in queue
    processQueue() {
        // Clean up expired sessions first
        this.cleanupExpiredSessions();

        if (this.queue.length === 0) {
            this.activeSession = null;
            return null;
        }

        // Get next session
        const nextSessionId = this.queue.shift();
        const session = this.sessions.get(nextSessionId);

        if (!session) {
            // Session no longer exists, process next
            return this.processQueue();
        }

        // Set as active
        this.activeSession = nextSessionId;
        session.status = 'active';
        session.activatedAt = Date.now();
        this.lastActivityTime.set(nextSessionId, Date.now());

        // Set timeout for this session
        setTimeout(() => {
            this.checkSessionTimeout(nextSessionId);
        }, this.sessionTimeout);

        console.log(`🎯 Session ${nextSessionId} is now active for payment`);
        return nextSessionId;
    }

    // Check if session has timed out
    checkSessionTimeout(sessionId) {
        if (this.activeSession !== sessionId) {
            return; // Session already completed or removed
        }

        const lastActivity = this.lastActivityTime.get(sessionId) || 0;
        const timeSinceActivity = Date.now() - lastActivity;

        if (timeSinceActivity >= this.sessionTimeout) {
            console.log(`⏰ Session ${sessionId} timed out`);
            this.removeSession(sessionId); // removeSession will call processQueue automatically
        } else {
            // Check again after remaining time
            setTimeout(() => {
                this.checkSessionTimeout(sessionId);
            }, this.sessionTimeout - timeSinceActivity);
        }
    }

    // Update session activity
    updateActivity(sessionId) {
        if (this.activeSession === sessionId) {
            this.lastActivityTime.set(sessionId, Date.now());
        }
    }

    // Complete session (after successful print)
    completeSession(sessionId) {
        this.completedSessions++;
        console.log(`✅ Session ${sessionId} completed [Total completed: ${this.completedSessions}]`);
        this.removeSession(sessionId); // removeSession will call processQueue automatically
    }

    // Remove session from system
    removeSession(sessionId, processNext = true) {
        const wasActive = this.activeSession === sessionId;
        const wasInQueue = this.queue.includes(sessionId);
        
        // Remove from active
        if (this.activeSession === sessionId) {
            this.activeSession = null;
        }

        // Remove from queue
        const queueIndex = this.queue.indexOf(sessionId);
        if (queueIndex > -1) {
            this.queue.splice(queueIndex, 1);
        }

        // Remove session data
        this.sessions.delete(sessionId);
        this.lastActivityTime.delete(sessionId);
        
        console.log(`🗑️ Session ${sessionId} removed [Was active: ${wasActive}, Was in queue: ${wasInQueue}, Queue length: ${this.queue.length}]`);
        
        // If this was the active session and we should process next, activate the next person in queue
        if (wasActive && processNext) {
            console.log(`🔄 Active session removed, processing next in queue... [${this.queue.length} waiting]`);
            this.processQueue();
        }
    }

    // Get queue status for a session
    getQueueStatus(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return {
                exists: false,
                message: 'Session not found'
            };
        }

        if (this.activeSession === sessionId) {
            return {
                exists: true,
                status: 'active',
                position: 0,
                canProceed: true,
                message: 'Your turn to pay',
                timeRemaining: Math.max(0, this.sessionTimeout - (Date.now() - (session.activatedAt || Date.now())))
            };
        }

        const position = this.queue.indexOf(sessionId) + 1;
        if (position > 0) {
            return {
                exists: true,
                status: 'waiting',
                position: position,
                canProceed: false,
                message: `You are #${position} in queue. Please wait...`,
                estimatedWait: position * 60 // Rough estimate in seconds
            };
        }

        return {
            exists: true,
            status: 'unknown',
            canProceed: false,
            message: 'Session status unknown'
        };
    }

    // Clean up expired sessions
    cleanupExpiredSessions() {
        const now = Date.now();
        const maxWaitTime = 10 * 60 * 1000; // 10 minutes max wait in queue

        for (const [sessionId, session] of this.sessions) {
            if (session.status === 'waiting' && (now - session.joinedAt) > maxWaitTime) {
                console.log(`🧹 Removing expired session ${sessionId}`);
                this.removeSession(sessionId);
            }
        }
    }

    // Get overall queue information
    getQueueInfo() {
        return {
            activeSession: this.activeSession,
            queueLength: this.queue.length,
            totalSessions: this.sessions.size,
            queue: this.queue.map((id, index) => ({
                sessionId: id,
                position: index + 1,
                fileInfo: this.sessions.get(id)?.fileInfo
            }))
        };
    }

    // Check if payment is allowed for session
    canProceedToPayment(sessionId) {
        return this.activeSession === sessionId;
    }
}

// Export singleton instance
module.exports = new QueueManager();
