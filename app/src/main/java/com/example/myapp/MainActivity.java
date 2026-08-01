
package com.example.myapp;

import android.app.Activity;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.widget.*;
import java.util.*;

public class MainActivity extends Activity {
    private EditText editTextTask;
    private TaskAdapter adapter;
    private ArrayList<Task> taskList;
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.main);

        prefs = getSharedPreferences("TodoPrefs", MODE_PRIVATE);
        loadTasks();

        editTextTask = findViewById(R.id.editTextTask);
        Button buttonAdd = findViewById(R.id.buttonAdd);
        ListView listViewTasks = findViewById(R.id.listViewTasks);

        adapter = new TaskAdapter(this, taskList, this::saveTasks);
        listViewTasks.setAdapter(adapter);

        buttonAdd.setOnClickListener(v -> {
            String text = editTextTask.getText().toString();
            if (!text.isEmpty()) {
                taskList.add(new Task(text, false));
                saveTasks();
                adapter.notifyDataSetChanged();
                editTextTask.setText("");
            }
        });

        listViewTasks.setOnItemLongClickListener((parent, view, position, id) -> {
            taskList.remove(position);
            saveTasks();
            adapter.notifyDataSetChanged();
            return true;
        });
    }

    private void saveTasks() {
        Set<String> set = new HashSet<>();
        for (Task t : taskList) {
            set.add(t.getText() + "|" + t.isCompleted());
        }
        prefs.edit().putStringSet("tasks", set).apply();
    }

    private void loadTasks() {
        taskList = new ArrayList<>();
        Set<String> set = prefs.getStringSet("tasks", new HashSet<>());
        for (String s : set) {
            String[] parts = s.split("\\|");
            taskList.add(new Task(parts[0], Boolean.parseBoolean(parts[1])));
        }
    }
}
