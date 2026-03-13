import { describe, it, expect } from 'vitest';
import { buildHelpBlocks } from '../../src/utils/slackHelpers';

describe('buildHelpBlocks', () => {
  const blocks = buildHelpBlocks();

  it('should return an array of blocks', () => {
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBeGreaterThan(5);
  });

  it('should start with a header block', () => {
    expect(blocks[0]).toHaveProperty('type', 'header');
    const text = (blocks[0] as any).text.text;
    expect(text).toContain('Gringo');
  });

  it('should contain channel descriptions', () => {
    const allText = JSON.stringify(blocks);
    expect(allText).toContain('#daily-lesson');
    expect(allText).toContain('#charla-libre');
    expect(allText).toContain('#lunfardo-del-dia');
    expect(allText).toContain('#repaso');
    expect(allText).toContain('#desafios');
  });

  it('should contain all user-facing commands', () => {
    const allText = JSON.stringify(blocks);
    expect(allText).toContain('/gringo help');
    expect(allText).toContain('/gringo level');
    expect(allText).toContain('/gringo stats');
    expect(allText).toContain('/gringo repaso');
    expect(allText).toContain('/gringo onboard');
    expect(allText).toContain('/gringo admin');
  });

  it('should not include admin commands in help output', () => {
    const allText = JSON.stringify(blocks);
    expect(allText).not.toContain('/admin');
  });

  it('should end with a context block', () => {
    const lastBlock = blocks[blocks.length - 1];
    expect(lastBlock).toHaveProperty('type', 'context');
  });

  it('should include dividers for visual separation', () => {
    const dividers = blocks.filter((b: any) => b.type === 'divider');
    expect(dividers.length).toBeGreaterThanOrEqual(2);
  });
});
