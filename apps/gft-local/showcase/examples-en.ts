import type { Example } from './examples';

// Translations of the same authored scenarios, not new user evidence.
export const englishExamples: readonly Example[] = [
  {
    id: 'product',
    name: 'First release of a bookkeeping app',
    category: 'Product decisions',
    headline: 'Why launch a bookkeeping app without bank sync?',
    scope:
      'Decide what to include in the first release of a bookkeeping app for freelancers and how to test it.',
    summary:
      'Bank sync can wait. Connecting to banks takes work and requires permission to read transactions. First, see whether freelancers can log a transaction by hand without help and come back a few days later to check their monthly totals.',
    sections: [
      [
        'Who it serves',
        'The freelancers in this example have irregular income and expenses spread across accounts. At the end of the month, they struggle to remember where the money went.',
      ],
      [
        'First release',
        'The first release includes manual entry and a monthly overview. If people keep recording transactions, consider bank sync to save them time.',
      ],
      [
        'Next validation',
        'Ask freelancers to log a real transaction. Note where they need help, then check whether they come back a few days later to review it.',
      ],
    ],
    nodes: [
      [
        '◆',
        'Who it serves',
        'Start with freelancers',
        'Irregular income and scattered expenses define the initial audience. Look for recurring problems within that group.',
      ],
      [
        '◆',
        'First release',
        'Complete one manual entry',
        'Enter an amount, choose a category, save, and immediately see the change in monthly totals.',
      ],
      [
        '◆',
        'First release',
        'Postpone bank sync',
        'Connecting to banks takes work and requires users to grant access to their transactions. First, see whether freelancers can log one by hand without help and come back a few days later to check it.',
      ],
      [
        '◇',
        'Next validation',
        'Watch the first unaided entry',
        'Ask a freelancer to log a real transaction and note where they need help.',
      ],
      [
        '？',
        'Next validation',
        'Will they return in a few days?',
        'This remains untested. Judge the first session separately from continued use.',
      ],
      [
        '◆',
        'Next validation',
        'Fix observed obstacles next',
        'Prioritize problems that prevent task completion, rather than adding features to lengthen a checklist.',
      ],
    ],
    edges: [
      [0, 1],
      [1, 2],
      [1, 3],
      [3, 4],
      [4, 5],
    ],
    editTip:
      'Edit the trial plan under “Next validation” in Doc. Open “Continue in another chat” to read the updated document.',
    nextPrompt:
      'read “First release of a bookkeeping app” and help me plan a trial with a freelancer. What should I watch during their first entry, and what should I check a few days later?',
  },
  {
    id: 'writing',
    name: 'Article: why remote teams keep meeting',
    category: 'Writing',
    headline: 'Keep your position and material when you change chats.',
    situation:
      'You discussed an opening, cut an argument, and collected a few stories. Tomorrow, you want to continue those choices instead of receiving another generic outline.',
    scope:
      'Write an experience-based article about meeting overload in remote teams. Keep the author’s position, concrete situations, limits of the argument, and missing material.',
    summary:
      'Use meetings for decisions that need joint discussion; move status updates beforehand. Open with three consecutive Monday meetings. Explain how missing written context causes repeated discussion without claiming all meetings are wasteful.',
    sections: [
      [
        'Author’s position',
        'Meetings themselves are not the problem. Without written context, everyone spends time catching up. Joint discussion still matters when there is a real disagreement.',
      ],
      [
        'Story and evidence',
        'Open with three Monday meetings that delayed actual work until afternoon. Follow with an example of sharing a decision document in advance; do not turn one person’s experience into a universal claim.',
      ],
      [
        'What to write next',
        'Add details of that decision meeting: what was shared, which disagreements remained, and who decided. End with a small action readers can try.',
      ],
    ],
    nodes: [
      [
        '◆',
        'Author’s position',
        'Write the context before the meeting',
        'Put status, constraints, and open decisions on one page so participants can read ahead.',
      ],
      [
        '◆',
        'Author’s position',
        'Use meetings for joint decisions',
        'Discuss real disagreements together; reading together is not the same as deciding together.',
      ],
      [
        '◆',
        'Story and evidence',
        'Open with three back-to-back meetings',
        'Describe what happened and why work began only in the afternoon, rather than complaining abstractly about efficiency.',
      ],
      [
        '✗',
        'Author’s position',
        'Cut “all meetings are a waste”',
        'The material does not support that claim, and it obscures cases that need a live discussion.',
      ],
      [
        '？',
        'Story and evidence',
        'Add the before-and-after details',
        'Show what the written document changed rather than saying the meeting felt more productive.',
      ],
      [
        '◇',
        'What to write next',
        'Try one page before the next meeting',
        'Write down context and questions in advance; use the meeting for remaining disagreements.',
      ],
    ],
    edges: [
      [2, 0],
      [0, 1],
      [1, 5],
      [3, 1],
      [4, 5],
    ],
    editTip:
      'Open Doc and add your own experience to the before-and-after details. Your edit stays in this tab and will be included in the downloaded map.',
    nextPrompt:
      'read “Article: why remote teams keep meeting” and continue the opening. Keep the position that meetings serve joint decisions; do not restore the rejected blanket claim.',
  },
  {
    id: 'engineering',
    name: 'Technical plan: resume interrupted uploads',
    category: 'Technical planning',
    headline: 'Keep the tradeoffs and reasons, not just a diagram.',
    situation:
      'You have discussed constraints, postponed alternatives, and the next tests. Take those decisions into the next coding conversation.',
    scope:
      'Track resumable large-file uploads, their constraints, and validation plan. Exclude unrelated colors and routine tasks.',
    summary:
      'Keep the current storage provider and implement chunked uploads with retries. The server records upload sessions and acknowledged chunks; clients query that state before resuming. Completion must be idempotent. Test interrupted connections, repeated completion, and expiry cleanup before any storage migration.',
    sections: [
      [
        'Recovery flow',
        'Only chunks acknowledged by the server count as complete. On reopening the page, query the upload session and send only missing chunks. Local progress is not authoritative.',
      ],
      [
        'Constraints and tradeoffs',
        'Keep the existing storage provider this round. Do not couple reliable uploads to an infrastructure migration. Check session ownership and make completion safe to retry.',
      ],
      [
        'Validation plan',
        'Interrupt both chunk transfers and completion requests, then verify file integrity after recovery. Also test repeated completion, expired sessions, and cleanup of unfinished chunks.',
      ],
    ],
    nodes: [
      [
        '◆',
        'Recovery flow',
        'Trust server-confirmed progress',
        'Local cache improves the experience but cannot mark unacknowledged chunks as complete.',
      ],
      [
        '◆',
        'Recovery flow',
        'Send only missing chunks',
        'Query acknowledged chunks through the upload session rather than restarting the entire file.',
      ],
      [
        '◆',
        'Constraints and tradeoffs',
        'Make completion idempotent',
        'Repeated requests must not duplicate merges or files; they should return the same completion result.',
      ],
      [
        '⏸',
        'Constraints and tradeoffs',
        'Keep the current storage provider',
        'Validate recovery on the existing service before taking on a separate migration.',
      ],
      [
        '？',
        'Validation plan',
        'Does recovery preserve file integrity?',
        'Check the file’s contents after resuming, not just whether the progress bar reaches 100%.',
      ],
      [
        '◇',
        'Validation plan',
        'Test retries and expired sessions',
        'Cover duplicate completion, unauthorized access to upload sessions, and cleanup of expired chunks.',
      ],
    ],
    edges: [
      [0, 1],
      [1, 2],
      [1, 3],
      [2, 4],
      [4, 5],
    ],
    editTip:
      'Open a Map node to read its reasoning, then edit the validation plan in Doc. Your next coding conversation can read the current plan.',
    nextPrompt:
      'read “Technical plan: resume interrupted uploads” and break down the implementation under its current constraints. Validate recovery and idempotent completion first; do not migrate storage this round.',
  },
];
