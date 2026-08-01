
package com.example.myapp;

import android.content.Context;
import android.graphics.Paint;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.CheckBox;
import java.util.List;

public class TaskAdapter extends ArrayAdapter<Task> {
    private final Runnable onTaskChanged;

    public TaskAdapter(Context context, List<Task> tasks, Runnable onTaskChanged) {
        super(context, 0, tasks);
        this.onTaskChanged = onTaskChanged;
    }

    @Override
    public View getView(int position, View convertView, ViewGroup parent) {
        Task task = getItem(position);
        if (convertView == null) {
            convertView = LayoutInflater.from(getContext()).inflate(R.layout.item_task, parent, false);
        }
        CheckBox checkBox = convertView.findViewById(R.id.checkBoxTask);
        checkBox.setText(task.getText());
        checkBox.setChecked(task.isCompleted());
        
        if (task.isCompleted()) {
            checkBox.setPaintFlags(checkBox.getPaintFlags() | Paint.STRIKE_THRU_TEXT_FLAG);
        } else {
            checkBox.setPaintFlags(checkBox.getPaintFlags() & (~Paint.STRIKE_THRU_TEXT_FLAG));
        }

        checkBox.setOnCheckedChangeListener((buttonView, isChecked) -> {
            task.setCompleted(isChecked);
            onTaskChanged.run();
            notifyDataSetChanged();
        });
        return convertView;
    }
}
