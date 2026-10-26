import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  MAT_DIALOG_DATA,
  MatDialogActions,
  MatDialogContent,
  MatDialogRef,
  MatDialogTitle,
} from '@angular/material/dialog';
import { MatButton } from '@angular/material/button';
import { MatRadioButton, MatRadioGroup } from '@angular/material/radio';
import { TranslatePipe } from '@ngx-translate/core';
import { T } from '../../../t.const';
import {
  MergeChoice,
  ProjectConflict,
} from '../../../op-log/sync/first-sync-merge/first-sync-merge';

export interface ProjectMergeConflictData {
  conflicts: ProjectConflict[];
}

/** One row per conflicting project; no cancel (the merge is already under way). */
@Component({
  selector: 'dialog-project-merge-conflict',
  templateUrl: './dialog-project-merge-conflict.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatDialogTitle,
    MatDialogContent,
    MatDialogActions,
    MatButton,
    MatRadioGroup,
    MatRadioButton,
    TranslatePipe,
  ],
})
export class DialogProjectMergeConflictComponent {
  private _dialogRef =
    inject<
      MatDialogRef<DialogProjectMergeConflictComponent, Record<string, MergeChoice>>
    >(MatDialogRef);
  readonly data = inject<ProjectMergeConflictData>(MAT_DIALOG_DATA);
  readonly T = T;

  readonly choices = signal<Record<string, MergeChoice>>({});
  readonly isComplete = computed(() =>
    this.data.conflicts.every((c) => !!this.choices()[c.projectId]),
  );

  setChoice(projectId: string, choice: MergeChoice): void {
    this.choices.update((cur) => ({ ...cur, [projectId]: choice }));
  }

  confirm(): void {
    if (this.isComplete()) {
      this._dialogRef.close(this.choices());
    }
  }
}
