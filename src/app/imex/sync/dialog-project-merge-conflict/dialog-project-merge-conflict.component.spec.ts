import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { TranslateModule } from '@ngx-translate/core';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { DialogProjectMergeConflictComponent } from './dialog-project-merge-conflict.component';
import { ProjectConflict } from '../../../op-log/sync/first-sync-merge/first-sync-merge';

describe('DialogProjectMergeConflictComponent', () => {
  let fixture: ComponentFixture<DialogProjectMergeConflictComponent>;
  let component: DialogProjectMergeConflictComponent;
  let dialogRef: jasmine.SpyObj<MatDialogRef<DialogProjectMergeConflictComponent>>;
  const conflicts: ProjectConflict[] = [
    { projectId: 'p1', title: 'Project One' },
    { projectId: 'p2', title: 'Project Two' },
  ];

  const confirmBtn = (): HTMLButtonElement =>
    fixture.nativeElement.querySelector('button.confirm-btn');

  beforeEach(async () => {
    dialogRef = jasmine.createSpyObj('MatDialogRef', ['close']);
    await TestBed.configureTestingModule({
      imports: [
        DialogProjectMergeConflictComponent,
        TranslateModule.forRoot(),
        NoopAnimationsModule,
      ],
      providers: [
        { provide: MatDialogRef, useValue: dialogRef },
        { provide: MAT_DIALOG_DATA, useValue: { conflicts } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(DialogProjectMergeConflictComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders one row per conflicting project with its title', () => {
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Project One');
    expect(text).toContain('Project Two');
    expect(fixture.nativeElement.querySelectorAll('mat-radio-group').length).toBe(2);
  });

  it('has no cancel button', () => {
    expect(fixture.nativeElement.querySelectorAll('button').length).toBe(1);
  });

  it('keeps confirm disabled until every project has a choice', () => {
    expect(confirmBtn().disabled).toBeTrue();
    component.setChoice('p1', 'LOCAL');
    fixture.detectChanges();
    expect(confirmBtn().disabled).toBeTrue();
    component.setChoice('p2', 'REMOTE');
    fixture.detectChanges();
    expect(confirmBtn().disabled).toBeFalse();
  });

  it('closes with the choices map on confirm', () => {
    component.setChoice('p1', 'LOCAL');
    component.setChoice('p2', 'REMOTE');
    fixture.detectChanges();
    confirmBtn().click();
    expect(dialogRef.close).toHaveBeenCalledWith({ p1: 'LOCAL', p2: 'REMOTE' });
  });

  it('does not close when confirm is called before all are decided', () => {
    component.setChoice('p1', 'LOCAL');
    component.confirm();
    expect(dialogRef.close).not.toHaveBeenCalled();
  });
});
