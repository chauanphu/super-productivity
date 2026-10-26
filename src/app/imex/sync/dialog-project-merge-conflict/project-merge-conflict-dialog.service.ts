import { inject, Injectable } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { UserInputWaitStateService } from '../user-input-wait-state.service';
import {
  MergeChoice,
  ProjectConflict,
} from '../../../op-log/sync/first-sync-merge/first-sync-merge';
import {
  DialogProjectMergeConflictComponent,
  ProjectMergeConflictData,
} from './dialog-project-merge-conflict.component';

@Injectable({ providedIn: 'root' })
export class ProjectMergeConflictDialogService {
  private _matDialog = inject(MatDialog);
  private _userInputWaitState = inject(UserInputWaitStateService);

  /**
   * Asks local/remote per conflicting project. Cannot be dismissed by the user;
   * a programmatic close (no choices) throws so the pending merge is retried later.
   */
  async open(conflicts: ProjectConflict[]): Promise<Record<string, MergeChoice>> {
    const stopWaiting = this._userInputWaitState.startWaiting('project-merge-conflict');
    try {
      const dialogRef = this._matDialog.open<
        DialogProjectMergeConflictComponent,
        ProjectMergeConflictData,
        Record<string, MergeChoice>
      >(DialogProjectMergeConflictComponent, {
        data: { conflicts },
        disableClose: true,
        restoreFocus: true,
      });
      const choices = await firstValueFrom(dialogRef.afterClosed());
      if (!choices) {
        throw new Error('Project merge conflict dialog closed without choices');
      }
      return choices;
    } finally {
      stopWaiting();
    }
  }
}
