import { describe, it, expect } from 'vitest';
import {
  buildWelcomeBlocks,
  buildLevelPickerBlocks,
  buildLevelConfirmationBlocks,
  buildVoiceTutorialBlocks,
  buildChannelGuideBlocks,
  buildFirstExerciseBlocks,
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
  });

  describe('buildLevelPickerBlocks', () => {
    it('should have 5 level buttons', () => {
      const blocks = buildLevelPickerBlocks();
      const actions = blocks.find((b: any) => b.type === 'actions') as any;
      expect(actions).toBeDefined();
      expect(actions.elements).toHaveLength(5);
    });

    it('should have correct action_ids', () => {
      const blocks = buildLevelPickerBlocks();
      const actions = blocks.find((b: any) => b.type === 'actions') as any;
      for (let i = 1; i <= 5; i++) {
        const btn = actions.elements.find((e: any) => e.action_id === `onboard_level_${i}`);
        expect(btn).toBeDefined();
        expect(btn.value).toBe(String(i));
      }
    });

    it('should include level descriptions in context', () => {
      const blocks = buildLevelPickerBlocks();
      const text = JSON.stringify(blocks);
      expect(text).toContain('never studied');
      expect(text).toContain('near native');
    });
  });

  describe('buildLevelConfirmationBlocks', () => {
    it('should show selected level', () => {
      const blocks = buildLevelConfirmationBlocks(3);
      const text = JSON.stringify(blocks);
      expect(text).toContain('Level 3');
      expect(text).toContain('Intermediate');
    });

    it('should mention /gringo level command', () => {
      const blocks = buildLevelConfirmationBlocks(1);
      const text = JSON.stringify(blocks);
      expect(text).toContain('/gringo level');
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
    it('should list all channels', () => {
      const blocks = buildChannelGuideBlocks();
      const text = JSON.stringify(blocks);
      expect(text).toContain('#charla-libre');
      expect(text).toContain('#daily-lesson');
      expect(text).toContain('#lunfardo-del-dia');
      expect(text).toContain('#repaso');
      expect(text).toContain('#desafios');
    });
  });

  describe('buildFirstExerciseBlocks', () => {
    it('should adapt exercise to level 1', () => {
      const blocks = buildFirstExerciseBlocks(1);
      const text = JSON.stringify(blocks);
      expect(text).toContain('Introduce yourself');
    });

    it('should adapt exercise to level 3', () => {
      const blocks = buildFirstExerciseBlocks(3);
      const text = JSON.stringify(blocks);
      expect(text).toContain('trip');
    });

    it('should adapt exercise to level 5', () => {
      const blocks = buildFirstExerciseBlocks(5);
      const text = JSON.stringify(blocks);
      expect(text).toContain('lunfardo');
    });

    it('should mention #charla-libre', () => {
      const blocks = buildFirstExerciseBlocks(2);
      const text = JSON.stringify(blocks);
      expect(text).toContain('#charla-libre');
    });
  });
});
