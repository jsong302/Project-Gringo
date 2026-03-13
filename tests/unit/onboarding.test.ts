import { describe, it, expect } from 'vitest';
import {
  buildWelcomeBlocks,
  buildSelfAssessmentBlocks,
  buildPlacementSkipBlocks,
  buildPlacementStartBlocks,
  buildResponseModeBlocks,
  buildVoiceTutorialBlocks,
  buildChannelGuideBlocks,
} from '../../src/services/onboarding';

describe('Onboarding Block Builders', () => {
  describe('buildWelcomeBlocks', () => {
    it('should include header and description', () => {
      const blocks = buildWelcomeBlocks();
      const text = JSON.stringify(blocks);
      expect(text).toContain('Welcome to Gringo');
      expect(text).toContain('porteño');
      expect(text).toContain('voseo');
    });

    it('should personalize with display name', () => {
      const blocks = buildWelcomeBlocks('Sarah');
      const text = JSON.stringify(blocks);
      expect(text).toContain('Sarah');
    });
  });

  describe('buildSelfAssessmentBlocks', () => {
    it('should have 4 assessment buttons', () => {
      const blocks = buildSelfAssessmentBlocks();
      const actions = blocks.find((b: any) => b.type === 'actions') as any;
      expect(actions).toBeDefined();
      expect(actions.elements).toHaveLength(4);
    });

    it('should have correct action_ids', () => {
      const blocks = buildSelfAssessmentBlocks();
      const actions = blocks.find((b: any) => b.type === 'actions') as any;
      for (let i = 1; i <= 4; i++) {
        const btn = actions.elements.find((e: any) => e.action_id === `onboard_assess_${i}`);
        expect(btn).toBeDefined();
      }
    });
  });

  describe('buildPlacementSkipBlocks', () => {
    it('should mention Unit 1', () => {
      const blocks = buildPlacementSkipBlocks();
      const text = JSON.stringify(blocks);
      expect(text).toContain('Unit 1');
    });
  });

  describe('buildPlacementStartBlocks', () => {
    it('should mention multiple-choice questions', () => {
      const blocks = buildPlacementStartBlocks();
      const text = JSON.stringify(blocks);
      expect(text).toContain('multiple-choice');
    });
  });

  describe('buildResponseModeBlocks', () => {
    it('should have text and voice buttons', () => {
      const blocks = buildResponseModeBlocks();
      const actions = blocks.find((b: any) => b.type === 'actions') as any;
      expect(actions).toBeDefined();
      expect(actions.elements).toHaveLength(2);
      expect(actions.elements[0].action_id).toBe('onboard_response_text');
      expect(actions.elements[1].action_id).toBe('onboard_response_voice');
    });
  });

  describe('buildVoiceTutorialBlocks', () => {
    it('should include desktop and mobile instructions', () => {
      const blocks = buildVoiceTutorialBlocks();
      const text = JSON.stringify(blocks);
      expect(text).toContain('desktop');
      expect(text).toContain('mobile');
      expect(text).toContain('Record audio clip');
      expect(text).toContain('microphone');
    });
  });

  describe('buildChannelGuideBlocks', () => {
    it('should list key channels', () => {
      const blocks = buildChannelGuideBlocks();
      const text = JSON.stringify(blocks);
      expect(text).toContain('#daily-lesson');
      expect(text).toContain('#lunfardo-del-dia');
      expect(text).toContain('#desafios');
    });
  });
});
