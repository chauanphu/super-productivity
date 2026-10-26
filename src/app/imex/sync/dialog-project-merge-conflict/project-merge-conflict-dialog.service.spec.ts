import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { of } from 'rxjs';
import { ProjectMergeConflictDialogService } from './project-merge-conflict-dialog.service';
import { UserInputWaitStateService } from '../user-input-wait-state.service';

describe('ProjectMergeConflictDialogService', () => {
  let matDialog: jasmine.SpyObj<MatDialog>;
  let waitState: jasmine.SpyObj<UserInputWaitStateService>;
  let stopWaiting: jasmine.Spy;

  const setup = (closeValue: unknown): ProjectMergeConflictDialogService => {
    matDialog = jasmine.createSpyObj('MatDialog', ['open']);
    matDialog.open.and.returnValue({ afterClosed: () => of(closeValue) } as never);
    stopWaiting = jasmine.createSpy('stopWaiting');
    waitState = jasmine.createSpyObj('UserInputWaitStateService', ['startWaiting']);
    waitState.startWaiting.and.returnValue(stopWaiting);
    TestBed.configureTestingModule({
      providers: [
        { provide: MatDialog, useValue: matDialog },
        { provide: UserInputWaitStateService, useValue: waitState },
      ],
    });
    return TestBed.inject(ProjectMergeConflictDialogService);
  };

  it('opens a non-dismissable dialog and returns the choices', async () => {
    const service = setup({ p1: 'LOCAL' });
    const res = await service.open([{ projectId: 'p1', title: 'P' }]);
    expect(res).toEqual({ p1: 'LOCAL' });
    expect(matDialog.open.calls.mostRecent().args[1]?.disableClose).toBeTrue();
    expect(waitState.startWaiting).toHaveBeenCalled();
    expect(stopWaiting).toHaveBeenCalled();
  });

  it('throws when the dialog is closed without choices (programmatic close)', async () => {
    const service = setup(undefined);
    await expectAsync(service.open([{ projectId: 'p1', title: 'P' }])).toBeRejected();
    expect(stopWaiting).toHaveBeenCalled();
  });
});
