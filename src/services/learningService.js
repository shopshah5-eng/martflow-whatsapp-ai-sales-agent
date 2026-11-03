/**
 * MartFlow AI — Safe Conversation-Based Learning Service
 * 
 * Safety & Privacy Guarantees:
 * 1. Strict Tenant Isolation: Learned knowledge is scoped exclusively to organization_id.
 * 2. Explicit Opt-In Consent: Learning is inactive unless org.learning_opt_in is explicitly true.
 * 3. Human in the Loop: Extracted facts are queued as proposals (pending_review).
 *    Nothing enters the AI context without explicit operator approval.
 * 4. Zero Model Retraining: Base LLM weights are never modified. Approved facts are
 *    injected strictly as grounded context into the tenant's prompt.
 * 5. One-Click Revocation: Operators can delete or reject facts with immediate cache invalidation.
 */

import crypto from 'crypto';
import db from '../db/index.js';
import { invalidateCache } from './aiService.js';

export class LearningService {
  /**
   * Check if organization has opted in to conversational learning
   */
  static isLearningOptedIn(organizationId) {
    if (!organizationId) return false;
    const org = db.findById('organizations', organizationId);
    const settings = db.findOne('ai_settings', (s) => s.organization_id === organizationId);
    return Boolean(org?.learning_opt_in ?? settings?.learning_opt_in ?? false);
  }

  /**
   * Propose facts from resolved or closed conversation turns
   */
  static proposeFactsFromConversation({ organizationId, conversationId, messages = [] }) {
    if (!organizationId) throw new Error('organization_id is required');
    if (!this.isLearningOptedIn(organizationId)) {
      return { skipped: true, reason: 'opt_in_required' };
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return { skipped: true, reason: 'no_messages' };
    }

    const proposals = [];
    const existing = db.findScoped('learning_proposals', organizationId);

    // Analyze buyer-seller exchanges for high-value business rules
    for (let i = 0; i < messages.length - 1; i++) {
      const q = (messages[i]?.text || messages[i]?.content || '').trim();
      const a = (messages[i + 1]?.text || messages[i + 1]?.content || '').trim();
      const senderQ = String(messages[i]?.sender || messages[i]?.sender_type || 'buyer').toLowerCase();
      const senderA = String(messages[i + 1]?.sender || messages[i + 1]?.sender_type || 'seller').toLowerCase();
      const isHumanSeller = ['owner', 'seller', 'human', 'agent', 'rep', 'client'].includes(senderA);

      if (senderQ === 'buyer' && isHumanSeller) {
        let topic = null;
        let fact = null;

        if (/warranty|guarantee|gurantee/i.test(q) && /year|month|comprehensive|service/i.test(a)) {
          topic = 'Warranty & Service';
          fact = `Warranty policy: ${a.slice(0, 200)}`;
        } else if (/dispatch|delivery|transport|shipping|kahan\s*kahan|all\s*india/i.test(q) && /day|dispatch|transport|delivery|v-trans|tci/i.test(a)) {
          topic = 'Delivery & Shipping';
          fact = `Delivery timeline & shipping terms: ${a.slice(0, 200)}`;
        } else if (/payment|advance|token|terms|gst/i.test(q) && /%|advance|cheque|neft|rtgs|invoice/i.test(a)) {
          topic = 'Payment Terms';
          fact = `Payment terms: ${a.slice(0, 200)}`;
        } else if (/custom|size|dimension|capacity|batch/i.test(q) && /custom|ban\s*sakta|possible|available/i.test(a)) {
          topic = 'Customization';
          fact = `Customization capability: ${a.slice(0, 200)}`;
        }

        if (topic && fact) {
          const isDuplicate = existing.some(
            (p) => p.topic === topic && p.proposed_fact === fact
          );
          if (!isDuplicate) {
            const proposal = db.insert('learning_proposals', {
              id: 'prop_' + crypto.randomBytes(8).toString('hex'),
              organization_id: organizationId,
              conversation_id: conversationId,
              topic,
              proposed_fact: fact,
              source_excerpt: `Buyer: "${q.slice(0, 100)}" -> Seller: "${a.slice(0, 100)}"`,
              status: 'pending_review',
              created_at: new Date().toISOString(),
              reviewed_at: null,
              reviewed_by: null
            });
            proposals.push(proposal);
          }
        }
      }
    }

    return { skipped: false, proposedCount: proposals.length, proposals };
  }

  /**
   * List proposals for an organization
   */
  static listProposals(organizationId, filter = {}) {
    if (!organizationId) throw new Error('organization_id is required');
    return db.findScoped('learning_proposals', organizationId, (p) => {
      if (filter.status && p.status !== filter.status) return false;
      if (filter.topic && p.topic !== filter.topic) return false;
      return true;
    });
  }

  /**
   * Approve a proposal and promote it to verified tenant knowledge
   */
  static approveProposal(organizationId, proposalId, reviewerUserId) {
    if (!organizationId || !proposalId) throw new Error('organization_id and proposalId required');
    const proposals = db.findScoped('learning_proposals', organizationId, (p) => p.id === proposalId);
    const proposal = proposals[0];
    if (!proposal) {
      const err = new Error('Learning proposal not found for this organization');
      err.statusCode = 404;
      throw err;
    }

    const now = new Date().toISOString();
    const updatedProposal = db.updateScoped('learning_proposals', proposal.id, organizationId, {
      status: 'approved',
      reviewed_at: now,
      reviewed_by: reviewerUserId || 'operator'
    });

    const factId = 'fact_' + proposal.id.replace(/^prop_/, '');
    const approvedFact = db.insert('approved_facts', {
      id: factId,
      organization_id: organizationId,
      proposal_id: proposal.id,
      topic: proposal.topic,
      fact: proposal.proposed_fact,
      approved_at: now,
      approved_by: reviewerUserId || 'operator'
    });

    invalidateCache(organizationId);
    return { ok: true, proposal: updatedProposal, approvedFact };
  }

  /**
   * Reject a proposal
   */
  static rejectProposal(organizationId, proposalId, reviewerUserId, reason = '') {
    if (!organizationId || !proposalId) throw new Error('organization_id and proposalId required');
    const proposals = db.findScoped('learning_proposals', organizationId, (p) => p.id === proposalId);
    const proposal = proposals[0];
    if (!proposal) {
      const err = new Error('Learning proposal not found for this organization');
      err.statusCode = 404;
      throw err;
    }

    const now = new Date().toISOString();
    const updated = db.updateScoped('learning_proposals', proposal.id, organizationId, {
      status: 'rejected',
      reviewed_at: now,
      reviewed_by: reviewerUserId || 'operator',
      rejection_reason: reason
    });

    return { ok: true, proposal: updated };
  }

  /**
   * List approved facts for an organization
   */
  static listApprovedFacts(organizationId) {
    if (!organizationId) throw new Error('organization_id is required');
    return db.findScoped('approved_facts', organizationId);
  }

  /**
   * Delete an approved fact (Instant Revocation)
   */
  static deleteApprovedFact(organizationId, factId) {
    if (!organizationId || !factId) throw new Error('organization_id and factId required');
    const existing = db.findScoped('approved_facts', organizationId, (f) => f.id === factId)[0];
    if (!existing) {
      const err = new Error('Approved fact not found for this organization');
      err.statusCode = 404;
      throw err;
    }

    db.deleteScoped('approved_facts', organizationId, (f) => f.id === factId);
    invalidateCache(organizationId);
    return { ok: true, deletedFactId: factId };
  }

  /**
   * Complete Tenant Opt-Out: Immediately purges all proposals, approved facts, and disables learning
   */
  static optOut(organizationId) {
    if (!organizationId) throw new Error('organization_id is required');
    db.update('organizations', organizationId, { learning_opt_in: false });
    const existingSettings = db.findOne('ai_settings', (s) => s.organization_id === organizationId);
    if (existingSettings) {
      db.updateScoped('ai_settings', existingSettings.id, organizationId, { learning_opt_in: false });
    }
    // Delete all proposed and approved facts for this tenant immediately
    db.deleteScoped('learning_proposals', organizationId, () => true);
    db.deleteScoped('approved_facts', organizationId, () => true);
    invalidateCache(organizationId);
    return { ok: true, optedOut: true };
  }

  /**
   * Retrieve formatted knowledge string for injection into tenant AI prompt
   */
  static getApprovedKnowledgeString(organizationId) {
    if (!organizationId) return '';
    if (!this.isLearningOptedIn(organizationId)) return '';
    const facts = db.findScoped('approved_facts', organizationId);
    if (!facts || facts.length === 0) return '';
    return '\nVERIFIED OPERATOR-APPROVED FACTS:\n' + facts.map((f) => `• [${f.topic}] ${f.fact}`).join('\n') + '\n';
  }
}

export default LearningService;
